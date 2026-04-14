/**
 * Google Sheets API — uses public gviz endpoint (no API key needed)
 * Sheet must be shared as "Anyone with the link can view"
 */

function _nextCol(col, offset) {
  return String.fromCharCode(col.charCodeAt(0) + offset);
}

function _buildRange(sheetTabName, statusColumn, rowIndex, endColOffset) {
  const endCol = _nextCol(statusColumn, endColOffset);
  return `${sheetTabName}!${statusColumn}${rowIndex}:${endCol}${rowIndex}`;
}

export const SheetsAPI = {
  async readSheet(spreadsheetId, sheetTabName) {
    const url = `https://docs.google.com/spreadsheets/d/${spreadsheetId}/gviz/tq?tqx=out:json&headers=1&sheet=${encodeURIComponent(sheetTabName)}`;
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Sheet read failed: ${response.status}. Make sure the sheet is shared publicly.`);
    }
    const text = await response.text();
    const jsonMatch = text.match(/google\.visualization\.Query\.setResponse\(({.*})\)/s);
    if (!jsonMatch) throw new Error('Failed to parse Google Sheets response.');

    const data = JSON.parse(jsonMatch[1]);
    if (data.status === 'error') {
      throw new Error(`Sheet error: ${data.errors?.[0]?.detailed_message || 'Unknown'}`);
    }

    const table = data.table;
    if (!table || !table.rows) return [];

    return table.rows.map(row =>
      row.c.map(cell => (cell && cell.v !== null && cell.v !== undefined) ? String(cell.v) : '')
    );
  },

  async writeRange(spreadsheetId, range, values, settings) {
    if (!settings.appsScriptUrl) {
      throw new Error('Apps Script URL not configured.');
    }
    const response = await fetch(settings.appsScriptUrl, {
      method: 'POST',
      body: JSON.stringify({ spreadsheetId, range, values }),
      headers: { 'Content-Type': 'text/plain' }
    });
    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Apps Script write failed (${response.status}): ${text}`);
    }
  },

  _colToIndex(col) {
    if (!col) return 0;
    return col.toUpperCase().charAt(0).charCodeAt(0) - 65;
  },

  async findPendingRow(settings) {
    const { sheetId, sheetTabName, startRow, topicColumn, statusColumn } = settings;
    const allRows = await this.readSheet(sheetId, sheetTabName);
    const dataStartIndex = (parseInt(startRow) || 2) - 2;
    const topicIdx = this._colToIndex(topicColumn || 'A');
    const statusIdx = this._colToIndex(statusColumn || 'B');

    for (let i = dataStartIndex; i < allRows.length; i++) {
      const rowIndex = i + 2;
      const row = allRows[i];
      const topic = row[topicIdx]?.trim();
      const status = row[statusIdx]?.trim()?.toLowerCase();

      if (topic && (!status || status === 'pending')) {
        return { topic, rowIndex };
      }
    }
    return null;
  },

  /**
   * Find ALL pending rows at once — used by batch mode to build the full queue upfront.
   * Returns array of { topic, rowIndex } sorted by row order.
   */
  async findAllPendingRows(settings) {
    const { sheetId, sheetTabName, startRow, topicColumn, statusColumn } = settings;
    const allRows = await this.readSheet(sheetId, sheetTabName);
    const dataStartIndex = (parseInt(startRow) || 2) - 2;
    const topicIdx = this._colToIndex(topicColumn || 'A');
    const statusIdx = this._colToIndex(statusColumn || 'B');
    const pending = [];

    for (let i = dataStartIndex; i < allRows.length; i++) {
      const rowIndex = i + 2;
      const row = allRows[i];
      const topic = row[topicIdx]?.trim();
      const status = row[statusIdx]?.trim()?.toLowerCase();

      if (topic && (!status || status === 'pending')) {
        pending.push({ topic, rowIndex });
      }
    }
    return pending;
  },

  async markProcessing(settings, rowIndex) {
    const { sheetId, sheetTabName, statusColumn } = settings;
    const range = `${sheetTabName}!${statusColumn}${rowIndex}`;
    await this.writeRange(sheetId, range, [['processing']], settings);
  },

  async markPending(settings, rowIndex) {
    const { sheetId, sheetTabName, statusColumn } = settings;
    const range = `${sheetTabName}!${statusColumn}${rowIndex}`;
    await this.writeRange(sheetId, range, [['pending']], settings);
  },

  async markError(settings, rowIndex, errorMsg = '') {
    const { sheetId, sheetTabName, statusColumn } = settings;
    const range = _buildRange(sheetTabName, statusColumn, rowIndex, 1);
    await this.writeRange(sheetId, range, [['error', errorMsg]], settings);
  },

  async markDone(settings, rowIndex, draftUrl = '', pinData = null) {
    const { sheetId, sheetTabName, statusColumn } = settings;
    const timestamp = new Date().toISOString().split('T')[0];

    // Base columns: status (B) | draftUrl (C) | timestamp (D)
    const row = ['done', draftUrl, timestamp];

    // Pinterest columns: category (E) | pin1 img (F) | pin1 desc (G) | pin1 title (H) | pin1 tags (I) | pin2... | pin3...
    if (pinData) {
      row.push(pinData.category || '');
      const pins = pinData.pins || [];
      for (let i = 0; i < 3; i++) {
        const pin = pins[i] || {};
        row.push(pin.imageUrl || '', pin.description || '', pin.title || '', pin.tags || '');
      }
    }

    // Calculate end column: statusColumn + number of extra columns
    const endColOffset = row.length - 1;
    const range = _buildRange(sheetTabName, statusColumn, rowIndex, endColOffset);
    await this.writeRange(sheetId, range, [row], settings);
  }
};
