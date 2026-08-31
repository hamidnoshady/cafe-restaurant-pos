<?php
/**
 * Plugin Name:       POS Accounting Connector
 * Plugin URI:        https://github.com/hamidnoshady/cafe-restaurant-pos
 * Description:       اتصال امن دوطرفه فروشگاه ووکامرس به سامانهٔ فروش و حسابداری: ارسال سفارش، برگشت وجه، محصول و مشتری؛ دریافت موجودی و قیمت.
 * Version:           1.2.0
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
 *
 * ## Three cron events, not one
 *
 * 1.1.0 split the single five-minute tick into three, because the three jobs
 * it was doing have three different costs and three different tolerances for
 * being late:
 *
 *   pos_connector_sync             every 5 minutes — handshake, push the
 *                                  queue, lease and apply jobs. Cheap, and
 *                                  it must be prompt: a sale that has just
 *                                  happened is the one that matters.
 *   pos_connector_resync_orders    every 15 minutes — re-send every order
 *                                  changed in the lookback window. Covers
 *                                  the events a hook missed.
 *   pos_connector_resync_products  hourly by default — re-send the whole
 *                                  catalogue, variations included. Expensive
 *                                  on a large store, so it is the one an
 *                                  owner is expected to turn down.
 *
 * Keeping them separate is what lets a shop with 10,000 products keep a
 * five-minute order latency without paying for a five-minute catalogue
 * export — and it is what makes "the products are stale but the orders are
 * fine" a diagnosable state rather than one number.
 */

defined( 'ABSPATH' ) || exit;

define( 'POS_CONNECTOR_VERSION', '1.2.0' );
define( 'POS_CONNECTOR_FILE', __FILE__ );
define( 'POS_CONNECTOR_PATH', plugin_dir_path( __FILE__ ) );

/** Option keys. Grouped in one array option so a single delete removes everything on uninstall. */
define( 'POS_CONNECTOR_OPTION', 'pos_connector_settings' );

/** The fast lane: handshake + push + pull. */
define( 'POS_CONNECTOR_CRON_HOOK', 'pos_connector_sync' );
/** The order sweep: re-send orders changed recently, in case a hook was missed. */
define( 'POS_CONNECTOR_CRON_RESYNC_ORDERS', 'pos_connector_resync_orders' );
/** The catalogue sweep: re-send the whole catalogue, variations included. */
define( 'POS_CONNECTOR_CRON_RESYNC_PRODUCTS', 'pos_connector_resync_products' );
/** The customer sweep: re-send the whole customer book (the backfill). */
define( 'POS_CONNECTOR_CRON_RESYNC_CUSTOMERS', 'pos_connector_resync_customers' );
/** The content sweep: re-send posts, pages and media. */
define( 'POS_CONNECTOR_CRON_RESYNC_CONTENT', 'pos_connector_resync_content' );

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

	// WP-CLI is optional and only exists on WP-CLI requests. Registering
	// through the CLI's own hook means the class is never loaded during a
	// normal page view, and `wp pos-connector …` can drive every job by hand
	// — which is how a host with a real crontab runs this plugin properly.
	if ( defined( 'WP_CLI' ) && WP_CLI ) {
		require_once POS_CONNECTOR_PATH . 'includes/class-pos-cli.php';
		POS_Connector_CLI::init();
	}
}
add_action( 'plugins_loaded', 'pos_connector_bootstrap' );

/**
 * Two extra intervals WordPress does not ship.
 *
 * Five minutes for the fast lane: stock and price changes are the payload most
 * sensitive to lag — an hour of drift is an hour of overselling — and WP-Cron's
 * own granularity (it only fires on traffic) makes the nominal interval an
 * upper bound already. Fifteen minutes for the order sweep, which is a
 * backstop rather than a primary path.
 */
function pos_connector_cron_schedules( $schedules ) {
	$schedules['pos_connector_five_minutes'] = array(
		'interval' => 5 * MINUTE_IN_SECONDS,
		'display'  => __( 'هر پنج دقیقه (اتصال حسابداری)', 'pos-accounting-connector' ),
	);
	$schedules['pos_connector_fifteen_minutes'] = array(
		'interval' => 15 * MINUTE_IN_SECONDS,
		'display'  => __( 'هر پانزده دقیقه (اتصال حسابداری)', 'pos-accounting-connector' ),
	);
	return $schedules;
}
add_filter( 'cron_schedules', 'pos_connector_cron_schedules' );

/**
 * The catalogued resync cadences, and the labels the settings screen shows.
 *
 * `''` is a real option — off — because a shop with a large catalogue may
 * legitimately decide a manual «همگام‌سازی محصولات» is enough, and a scheduled
 * job nobody can disable is a scheduled job that gets the plugin uninstalled.
 */
function pos_connector_resync_schedules() {
	return array(
		''                              => __( 'خاموش (فقط دستی)', 'pos-accounting-connector' ),
		'pos_connector_fifteen_minutes' => __( 'هر ۱۵ دقیقه', 'pos-accounting-connector' ),
		'hourly'                        => __( 'هر ساعت', 'pos-accounting-connector' ),
		'twicedaily'                    => __( 'دو بار در روز', 'pos-accounting-connector' ),
		'daily'                         => __( 'روزانه', 'pos-accounting-connector' ),
	);
}

/** Schedules allowed for the order sweep only — a catalogue cadence is too slow here. */
function pos_connector_order_resync_schedules() {
	return array(
		''                              => __( 'خاموش (فقط دستی)', 'pos-accounting-connector' ),
		'pos_connector_five_minutes'    => __( 'هر ۵ دقیقه', 'pos-accounting-connector' ),
		'pos_connector_fifteen_minutes' => __( 'هر ۱۵ دقیقه', 'pos-accounting-connector' ),
		'hourly'                        => __( 'هر ساعت', 'pos-accounting-connector' ),
		'daily'                         => __( 'روزانه', 'pos-accounting-connector' ),
	);
}

/**
 * (Re)arm one scheduled event, or clear it when its cadence is off.
 *
 * Called on activation and whenever a cadence setting changes, because a
 * changed interval that is never applied is worse than no setting at all:
 * the screen would show «هر ساعت» while WP-Cron kept firing daily.
 */
function pos_connector_schedule_event( $hook, $schedule ) {
	// Clear first, always: re-scheduling an existing hook is a no-op in
	// WP-Cron, so without this a changed cadence would never take effect.
	wp_clear_scheduled_hook( $hook );
	if ( '' === $schedule ) {
		return;
	}
	$allowed = array_keys(
		'pos_connector_resync_products' === $hook
			? pos_connector_resync_schedules()
			: pos_connector_order_resync_schedules()
	);
	if ( ! in_array( $schedule, $allowed, true ) ) {
		return;
	}
	wp_schedule_event( time() + MINUTE_IN_SECONDS, $schedule, $hook );
}

function pos_connector_activate() {
	POS_Connector_Log::install_table();
	POS_Connector_Queue::install_table();

	$settings = pos_connector_settings();

	if ( ! wp_next_scheduled( POS_CONNECTOR_CRON_HOOK ) ) {
		wp_schedule_event( time() + MINUTE_IN_SECONDS, 'pos_connector_five_minutes', POS_CONNECTOR_CRON_HOOK );
	}
	pos_connector_schedule_event( POS_CONNECTOR_CRON_RESYNC_ORDERS, $settings['resync_orders_schedule'] );
	pos_connector_schedule_event( POS_CONNECTOR_CRON_RESYNC_PRODUCTS, $settings['resync_products_schedule'] );
	// Daily backfills. Customers and content have no real-time cost worth a
	// finer cadence; the daily sweep is the backstop for anything a hook or
	// the initial export missed.
	if ( ! wp_next_scheduled( POS_CONNECTOR_CRON_RESYNC_CUSTOMERS ) ) {
		wp_schedule_event( time() + HOUR_IN_SECONDS, 'daily', POS_CONNECTOR_CRON_RESYNC_CUSTOMERS );
	}
	if ( ! wp_next_scheduled( POS_CONNECTOR_CRON_RESYNC_CONTENT ) ) {
		wp_schedule_event( time() + 2 * HOUR_IN_SECONDS, 'daily', POS_CONNECTOR_CRON_RESYNC_CONTENT );
	}
}
register_activation_hook( __FILE__, 'pos_connector_activate' );

function pos_connector_deactivate() {
	// The queue and log tables are deliberately left in place: deactivating to
	// debug something should not throw away the unsent events that would
	// explain it. `uninstall.php` is where data is actually removed.
	wp_clear_scheduled_hook( POS_CONNECTOR_CRON_HOOK );
	wp_clear_scheduled_hook( POS_CONNECTOR_CRON_RESYNC_ORDERS );
	wp_clear_scheduled_hook( POS_CONNECTOR_CRON_RESYNC_PRODUCTS );
	wp_clear_scheduled_hook( POS_CONNECTOR_CRON_RESYNC_CUSTOMERS );
	wp_clear_scheduled_hook( POS_CONNECTOR_CRON_RESYNC_CONTENT );
}
register_deactivation_hook( __FILE__, 'pos_connector_deactivate' );

/** Current settings, with every key guaranteed present so callers need no null checks. */
function pos_connector_settings() {
	$defaults = array(
		'base_url'                 => '',
		'token'                    => '',
		'enabled'                  => false,
		'sync_orders'              => true,
		'sync_products'            => true,
		'sync_customers'           => true,
		'apply_stock'              => true,
		'apply_prices'             => true,
		'last_ok_at'               => '',
		'last_error'               => '',
		// 1.1.0 — the scheduled sweeps. Orders default on (a missed hook is a
		// missing sale); products default to hourly (a full export is not
		// free, and an hourly backstop is enough for a catalogue that also
		// syncs on every save).
		'resync_orders_schedule'   => 'pos_connector_fifteen_minutes',
		'resync_products_schedule' => 'hourly',
		'resync_orders_days'       => 7,
		// Per-sweep bookkeeping, so the screen can say which one is stale.
		'last_orders_sweep_at'     => '',
		'last_products_sweep_at'   => '',
		'last_customers_sweep_at'  => '',
		'last_content_sweep_at'    => '',
		'last_run_stats'           => array(),
	);
	$stored = get_option( POS_CONNECTOR_OPTION, array() );
	return wp_parse_args( is_array( $stored ) ? $stored : array(), $defaults );
}

function pos_connector_update_settings( array $changes ) {
	update_option( POS_CONNECTOR_OPTION, array_merge( pos_connector_settings(), $changes ), false );
}
