<?php
/**
 * Uninstall — the only place this plugin actually destroys anything.
 *
 * Deactivation deliberately keeps the queue and the log (see the deactivation
 * hook), because deactivating to investigate a problem should not delete the
 * evidence. Deleting the plugin is an explicit "I am done with this", so the
 * credential goes first and the tables follow.
 */

defined( 'WP_UNINSTALL_PLUGIN' ) || exit;

delete_option( 'pos_connector_settings' );

global $wpdb;
// phpcs:disable WordPress.DB.DirectDatabaseQuery -- schema teardown has no API.
$wpdb->query( "DROP TABLE IF EXISTS {$wpdb->prefix}pos_connector_queue" );
$wpdb->query( "DROP TABLE IF EXISTS {$wpdb->prefix}pos_connector_log" );

wp_clear_scheduled_hook( 'pos_connector_sync' );
