<?php
/**
 * Plugin Name:       POS Accounting Connector
 * Plugin URI:        https://github.com/hamidnoshady/cafe-restaurant-pos
 * Description:       اتصال امن دوطرفه فروشگاه ووکامرس به سامانهٔ فروش و حسابداری: ارسال سفارش، برگشت وجه، محصول و مشتری؛ دریافت موجودی و قیمت.
 * Version:           1.0.1
 * Requires at least: 6.0
 * Requires PHP:      7.4
 * WC requires at least: 7.0
 * Text Domain:       pos-accounting-connector
 * Domain Path:       /languages
 * License:           GPL-2.0-or-later
 *
 * The WordPress half of the plugin link (see the app's
 * src/lib/integrations/plugin-service.ts for the other half and why it exists).
 *
 * Everything this plugin does is outbound: it pushes the events it observes and
 * pulls the work it should apply. The accounting system never dials in, so a
 * store behind a firewall, on a host that blocks incoming webhooks, or without
 * a stable public address works exactly the same — which is the main reason
 * this exists alongside the REST/consumer-key setup it replaces.
 *
 * Every request carries a bearer token, a timestamp, a nonce and an HMAC over
 * the exact request body. See class-pos-client.php.
 */

defined( 'ABSPATH' ) || exit;

define( 'POS_CONNECTOR_VERSION', '1.0.1' );
define( 'POS_CONNECTOR_FILE', __FILE__ );
define( 'POS_CONNECTOR_PATH', plugin_dir_path( __FILE__ ) );

/** Option keys. Grouped in one array option so a single delete removes everything on uninstall. */
define( 'POS_CONNECTOR_OPTION', 'pos_connector_settings' );

/** The WP-Cron hook that drives both directions of the sync. */
define( 'POS_CONNECTOR_CRON_HOOK', 'pos_connector_sync' );

require_once POS_CONNECTOR_PATH . 'includes/class-pos-log.php';
require_once POS_CONNECTOR_PATH . 'includes/class-pos-client.php';
require_once POS_CONNECTOR_PATH . 'includes/class-pos-queue.php';
require_once POS_CONNECTOR_PATH . 'includes/class-pos-sync.php';
require_once POS_CONNECTOR_PATH . 'includes/class-pos-settings.php';

/**
 * WooCommerce is a hard requirement, not a soft one: every hook this plugin
 * registers and every entity it maps is a WooCommerce concept. Failing loudly
 * at activation beats a plugin that activates and then silently does nothing.
 */
function pos_connector_woocommerce_active() {
	return class_exists( 'WooCommerce' );
}

function pos_connector_bootstrap() {
	if ( ! pos_connector_woocommerce_active() ) {
		add_action(
			'admin_notices',
			static function () {
				echo '<div class="notice notice-error"><p>';
				esc_html_e( 'افزونهٔ «اتصال حسابداری» به ووکامرس نیاز دارد. ابتدا ووکامرس را نصب و فعال کنید.', 'pos-accounting-connector' );
				echo '</p></div>';
			}
		);
		return;
	}

	POS_Connector_Settings::init();
	POS_Connector_Sync::init();
}
add_action( 'plugins_loaded', 'pos_connector_bootstrap' );

/**
 * Five minutes, added rather than reusing `hourly`: stock and price changes
 * are the payload most sensitive to lag — an hour of drift is an hour of
 * overselling — and WP-Cron's own granularity (it only fires on traffic) makes
 * the nominal interval an upper bound already.
 */
function pos_connector_cron_schedules( $schedules ) {
	$schedules['pos_connector_five_minutes'] = array(
		'interval' => 5 * MINUTE_IN_SECONDS,
		'display'  => __( 'هر پنج دقیقه (اتصال حسابداری)', 'pos-accounting-connector' ),
	);
	return $schedules;
}
add_filter( 'cron_schedules', 'pos_connector_cron_schedules' );

function pos_connector_activate() {
	POS_Connector_Log::install_table();
	POS_Connector_Queue::install_table();
	if ( ! wp_next_scheduled( POS_CONNECTOR_CRON_HOOK ) ) {
		wp_schedule_event( time() + MINUTE_IN_SECONDS, 'pos_connector_five_minutes', POS_CONNECTOR_CRON_HOOK );
	}
}
register_activation_hook( __FILE__, 'pos_connector_activate' );

function pos_connector_deactivate() {
	// The queue and log tables are deliberately left in place: deactivating to
	// debug something should not throw away the unsent events that would
	// explain it. `uninstall.php` is where data is actually removed.
	wp_clear_scheduled_hook( POS_CONNECTOR_CRON_HOOK );
}
register_deactivation_hook( __FILE__, 'pos_connector_deactivate' );

/** Current settings, with every key guaranteed present so callers need no null checks. */
function pos_connector_settings() {
	$defaults = array(
		'base_url'       => '',
		'token'          => '',
		'enabled'        => false,
		'sync_orders'    => true,
		'sync_products'  => true,
		'sync_customers' => true,
		'apply_stock'    => true,
		'apply_prices'   => true,
		'last_ok_at'     => '',
		'last_error'     => '',
	);
	$stored = get_option( POS_CONNECTOR_OPTION, array() );
	return wp_parse_args( is_array( $stored ) ? $stored : array(), $defaults );
}

function pos_connector_update_settings( array $changes ) {
	update_option( POS_CONNECTOR_OPTION, array_merge( pos_connector_settings(), $changes ), false );
}
