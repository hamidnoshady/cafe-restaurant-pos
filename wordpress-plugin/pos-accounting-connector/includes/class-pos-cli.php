<?php
/**
 * WP-CLI commands.
 *
 * The reason this file exists is one sentence from the app's own admin screen:
 * «کرون داخلی وردپرس فقط هنگام بازدید از سایت اجرا می‌شود». WP-Cron is a
 * best-effort scheduler driven by traffic; on a quiet store it does not run at
 * the interval it advertises, and on a store behind full-page caching it can
 * go hours without firing at all. Every deployment that cares runs a real
 * crontab that calls `wp cron event run --due-now` — or, with these commands,
 * drives the sync directly.
 *
 *   wp pos-connector status                      what is configured, what is queued, when each event runs
 *   wp pos-connector sync                        the fast lane: handshake, push, pull
 *   wp pos-connector export products             queue the whole catalogue
 *   wp pos-connector export orders [--days=7]    queue recently-modified orders
 *   wp pos-connector export customers            queue every customer
 *   wp pos-connector test                        ping the accounting system
 *
 * Every write command is safe to call as often as a crontab likes: the queue
 * dedups on (topic, remote_id) while a row is pending, and the app dedups on
 * delivery id, so running this every minute costs one HTTP round trip rather
 * than a thousand duplicate sales.
 */

defined( 'ABSPATH' ) || exit;

class POS_Connector_CLI {

	public static function init() {
		WP_CLI::add_command( 'pos-connector', __CLASS__ );
	}

	private static function require_configured() {
		$settings = pos_connector_settings();
		if ( empty( $settings['enabled'] ) ) {
			WP_CLI::error( 'همگام‌سازی غیرفعال است. ابتدا در ووکامرس ← اتصال حسابداری آن را فعال کنید.' );
		}
		if ( empty( $settings['base_url'] ) || empty( $settings['token'] ) ) {
			WP_CLI::error( 'آدرس سامانه یا توکن وارد نشده است.' );
		}
		return $settings;
	}

	/**
	 * Show what is configured, what is queued, and when each cron event runs.
	 *
	 * ## EXAMPLES
	 *
	 *     wp pos-connector status
	 *
	 * @subcommand status
	 */
	public function status( $args, $assoc_args ) {
		$settings = pos_connector_settings();
		$counts   = POS_Connector_Queue::counts();

		WP_CLI::log( WP_CLI::colorize( '%B' . __( 'اتصال حسابداری', 'pos-accounting-connector' ) . '%n' ) );
		WP_CLI::log( '  ' . sprintf( 'نسخهٔ افزونه: %s', POS_CONNECTOR_VERSION ) );
		WP_CLI::log( '  ' . sprintf( 'آدرس سامانه: %s', $settings['base_url'] ? $settings['base_url'] : '—' ) );
		WP_CLI::log( '  ' . sprintf( 'توکن: %s', $settings['token'] ? __( 'ثبت شده', 'pos-accounting-connector' ) : '—' ) );
		WP_CLI::log( '  ' . sprintf( 'وضعیت: %s', $settings['enabled'] ? __( 'فعال', 'pos-accounting-connector' ) : __( 'غیرفعال', 'pos-accounting-connector' ) ) );
		WP_CLI::log( '  ' . sprintf( 'آخرین ارتباط موفق: %s', $settings['last_ok_at'] ? $settings['last_ok_at'] : '—' ) );
		if ( ! empty( $settings['last_error'] ) ) {
			WP_CLI::warning( sprintf( 'آخرین خطا: %s', $settings['last_error'] ) );
		}

		WP_CLI::log( '' );
		WP_CLI::log( WP_CLI::colorize( '%B' . __( 'صف ارسال', 'pos-accounting-connector' ) . '%n' ) );
		WP_CLI::log( '  ' . sprintf( 'در انتظار: %d • ارسال‌شده: %d • ناموفق: %d • در انتظارِ بازگشت: %d', $counts['pending'], $counts['sent'], $counts['failed'], POS_Connector_Queue::deferred_count() ) );

		WP_CLI::log( '' );
		WP_CLI::log( WP_CLI::colorize( '%B' . __( 'زمان‌بندی', 'pos-accounting-connector' ) . '%n' ) );
		foreach ( array(
			POS_CONNECTOR_CRON_HOOK               => __( 'همگام‌سازی سریع', 'pos-accounting-connector' ),
			POS_CONNECTOR_CRON_RESYNC_ORDERS      => __( 'بازخوانی سفارش‌ها', 'pos-accounting-connector' ),
			POS_CONNECTOR_CRON_RESYNC_PRODUCTS    => __( 'بازخوانی محصولات', 'pos-accounting-connector' ),
		) as $hook => $label ) {
			$next = wp_next_scheduled( $hook );
			WP_CLI::log(
				'  ' . sprintf(
					'%s: %s (%s)',
					$label,
					$next ? gmdate( 'Y-m-d H:i:s', $next ) . ' UTC' : __( 'زمان‌بندی نشده', 'pos-accounting-connector' ),
					wp_get_schedule( $hook ) ? wp_get_schedule( $hook ) : '—'
				)
			);
		}

		if ( ! defined( 'DISABLE_WP_CRON' ) || ! DISABLE_WP_CRON ) {
			WP_CLI::log( '' );
			WP_CLI::warning(
				__( 'WP-Cron همچنان فعال است و فقط هنگام بازدید از سایت اجرا می‌شود. برای همگام‌سازی دقیق، آن را غیرفعال و یک کرون واقعی تنظیم کنید:', 'pos-accounting-connector' )
			);
			WP_CLI::log( '  */5 * * * * wp --path=' . ABSPATH . ' pos-connector sync > /dev/null 2>&1' );
		}
	}

	/**
	 * Run the fast lane: handshake, push queued events, lease and apply jobs.
	 *
	 * ## EXAMPLES
	 *
	 *     wp pos-connector sync
	 *
	 * @subcommand sync
	 */
	public function sync( $args, $assoc_args ) {
		self::require_configured();
		$stats = POS_Connector_Sync::run();
		if ( ! $stats ) {
			WP_CLI::error( 'اجرا ناموفق بود؛ گزارش رویدادها را ببینید.' );
		}
		WP_CLI::success(
			sprintf( 'ارسال: %d • اعمال: %d', (int) $stats['pushed'], (int) $stats['applied'] )
		);
	}

	/**
	 * Test the connection.
	 *
	 * ## EXAMPLES
	 *
	 *     wp pos-connector test
	 *
	 * @subcommand test
	 */
	public function test( $args, $assoc_args ) {
		self::require_configured();
		$client   = POS_Connector_Client::from_settings();
		$response = $client->post( '/api/integrations/wordpress/ping' );
		if ( $response['ok'] ) {
			WP_CLI::success( __( 'اتصال برقرار است.', 'pos-accounting-connector' ) );
		}
		WP_CLI::error( POS_Connector_Client::explain( $response['error'] ) );
	}

	/**
	 * Queue a full export.
	 *
	 * ## OPTIONS
	 *
	 * <kind>
	 * : What to export — products, orders or customers.
	 *
	 * [--days=<days>]
	 * : For `orders`, how far back to look. Default 7.
	 *
	 * ## EXAMPLES
	 *
	 *     wp pos-connector export products
	 *     wp pos-connector export orders --days=30
	 *
	 * @subcommand export
	 */
	public function export( $args, $assoc_args ) {
		self::require_configured();
		$kind = isset( $args[0] ) ? strtolower( (string) $args[0] ) : '';

		switch ( $kind ) {
			case 'products':
				POS_Connector_Sync::export_products();
				WP_CLI::success( __( 'محصولات در صف قرار گرفتند.', 'pos-accounting-connector' ) );
				return;
			case 'orders':
				$days = isset( $assoc_args['days'] ) ? (int) $assoc_args['days'] : (int) pos_connector_settings()['resync_orders_days'];
				$count = POS_Connector_Sync::export_orders( $days );
				WP_CLI::success( sprintf( '%d سفارش در صف قرار گرفت.', $count ) );
				return;
			case 'customers':
				POS_Connector_Sync::export_customers();
				WP_CLI::success( __( 'مشتریان در صف قرار گرفتند.', 'pos-accounting-connector' ) );
				return;
			default:
				WP_CLI::error( 'نوع را مشخص کنید: products | orders | customers' );
		}
	}
}
