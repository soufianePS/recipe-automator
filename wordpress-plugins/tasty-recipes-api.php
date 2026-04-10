<?php
/**
 * Plugin Name: Tasty Recipes API Bridge
 * Description: Adds REST API endpoint to create Tasty Recipes programmatically
 * Version: 1.0
 * Author: Recipe Automator
 */

if (!defined('ABSPATH')) exit;

add_action('rest_api_init', function() {
    register_rest_route('tasty-recipes/v1', '/create', [
        'methods'             => 'POST',
        'callback'            => 'tr_api_create_recipe',
        'permission_callback' => function() {
            return current_user_can('edit_posts');
        }
    ]);
});

function tr_api_create_recipe($request) {
    $params = $request->get_json_params();

    if (empty($params['title'])) {
        return new WP_Error('missing_title', 'Recipe title is required', ['status' => 400]);
    }

    // Create the tasty_recipe post
    $post_id = wp_insert_post([
        'post_type'   => 'tasty_recipe',
        'post_status' => 'publish',
        'post_title'  => sanitize_text_field($params['title']),
    ]);

    if (is_wp_error($post_id)) {
        return $post_id;
    }

    // Text fields
    $text_fields = ['prep_time', 'cook_time', 'total_time', 'yield', 'category', 'cuisine', 'keywords', 'author_name', 'method', 'diet'];
    foreach ($text_fields as $field) {
        if (isset($params[$field])) {
            update_post_meta($post_id, $field, sanitize_text_field($params[$field]));
        }
    }

    // HTML fields (ingredients, instructions, description, notes)
    $html_fields = ['description', 'ingredients', 'instructions', 'notes'];
    foreach ($html_fields as $field) {
        if (isset($params[$field])) {
            update_post_meta($post_id, $field, wp_kses_post($params[$field]));
        }
    }

    // Image ID (must be valid WP attachment)
    if (!empty($params['image_id'])) {
        $image_id = intval($params['image_id']);
        update_post_meta($post_id, 'image_id', $image_id);
        set_post_thumbnail($post_id, $image_id);
    }

    // Nutrition fields (Pro feature)
    $nutrition_fields = ['calories', 'protein', 'fat', 'saturated_fat', 'unsaturated_fat', 'trans_fat', 'carbohydrates', 'fiber', 'sugar', 'sodium', 'cholesterol', 'serving_size'];
    foreach ($nutrition_fields as $field) {
        if (isset($params[$field])) {
            update_post_meta($post_id, $field, sanitize_text_field($params[$field]));
        }
    }

    return [
        'success'   => true,
        'recipe_id' => $post_id,
        'shortcode' => '[tasty-recipe id="' . $post_id . '"]',
        'block'     => '<!-- wp:wp-tasty/tasty-recipe {"id":' . $post_id . '} /-->'
    ];
}
