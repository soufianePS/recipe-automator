<?php
/**
 * Plugin Name: Yoast REST API Meta
 * Description: Exposes Yoast SEO meta fields to the WordPress REST API for automated publishing
 * Version: 1.0
 * Author: Recipe Automator
 */

if (!defined('ABSPATH')) exit;

add_action('init', function() {
    $fields = [
        '_yoast_wpseo_title',
        '_yoast_wpseo_metadesc',
        '_yoast_wpseo_focuskw',
        '_yoast_wpseo_opengraph_title',
        '_yoast_wpseo_opengraph_description',
    ];

    foreach ($fields as $field) {
        register_meta('post', $field, [
            'show_in_rest'  => true,
            'single'        => true,
            'type'          => 'string',
            'auth_callback' => function() {
                return current_user_can('edit_posts');
            }
        ]);
    }
});
