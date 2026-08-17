<?php
/**
 * The sync log.
 *
 * Separate from the queue on purpose: the queue is *work*, this is *history*.
 * When a shop owner says "the stock is wrong", the question is what this
 * plugin did and when — including the runs where it did nothing, which a
 * work queue by definition does not record.
 */

defined( 'ABSPATH' ) || exit;

class POS_Connector_Log {

	const TABLE = 'pos_connector_log';

	/** Kept small: this is a diagnostic tail, not an archive. */
	const KEEP_ROWS = 500;

	public static function table_name() {
		global $wpdb;
		return $wpdb->prefix . self::TABLE;
	}

	public static function install_table() {
		global $wpdb;
		$table   = self::table_name();
		$charset = $wpdb->get_charset_collate();

		require_once ABSPATH . 'wp-admin/includes/upgrade.php';
		dbDelta(
			"CREATE TABLE {$table} (
				id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
				level VARCHAR(16) NOT NULL DEFAULT 'info',
				action VARCHAR(64) NOT NULL,
				message TEXT NULL,
				created_at DATETIME NOT NULL,
				PRIMARY KEY  (id),
				KEY created_at (created_at)
			) {$charset};"
		);
	}

	public static function write( $level, $action, $message = '' ) {
		global $wpdb;
		$wpdb->insert(
			self::table_name(),
			array(
				'level'      => (string) $level,
				'action'     => (string) $action,
				'message'    => is_scalar( $message ) ? (string) $message : wp_json_encode( $message ),
				'created_at' => current_time( 'mysql', true ),
			),
			array( '%s', '%s', '%s', '%s' )
		);
	}

	public static function info( $action, $message = '' ) {
		self::write( 'info', $action, $message );
	}

	public static function error( $action, $message = '' ) {
		self::write( 'error', $action, $message );
	}

	public static function recent( $limit = 50 ) {
		global $wpdb;
		$table = self::table_name();
		return $wpdb->get_results(
			$wpdb->prepare( "SELECT * FROM {$table} ORDER BY id DESC LIMIT %d", $limit ),
			ARRAY_A
		);
	}

	/** Trim to the newest KEEP_ROWS. Called from the cron run, so it costs nothing on a page view. */
	public static function prune() {
		global $wpdb;
		$table  = self::table_name();
		$cutoff = $wpdb->get_var(
			$wpdb->prepare( "SELECT id FROM {$table} ORDER BY id DESC LIMIT 1 OFFSET %d", self::KEEP_ROWS )
		);
		if ( $cutoff ) {
			$wpdb->query( $wpdb->prepare( "DELETE FROM {$table} WHERE id <= %d", (int) $cutoff ) );
		}
	}
}
