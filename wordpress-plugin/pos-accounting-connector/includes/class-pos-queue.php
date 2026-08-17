<?php
/**
 * The plugin's outbound queue.
 *
 * Nothing is sent from inside a WooCommerce hook. A hook fires during
 * checkout, in the customer's request, and an HTTP call to another host there
 * would put that host's latency — and its outages — directly into the
 * checkout. So a hook writes one row here and returns; the cron run sends it.
 *
 * That also gives the retry story for free: an order that could not be
 * delivered while the accounting system was down is still in this table when
 * it comes back, which is the difference between "the sale is recorded late"
 * and "the sale is lost".
 *
 * Each row carries a `delivery_id` generated once, at enqueue time, and reused
 * on every retry — that is the idempotency key the app dedups on, so a
 * re-send after a timeout can never double-post a sale.
 */

defined( 'ABSPATH' ) || exit;

class POS_Connector_Queue {

	const TABLE = 'pos_connector_queue';

	/** Give up after this many tries and leave the row for an operator to see. */
	const MAX_ATTEMPTS = 8;

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
				topic VARCHAR(64) NOT NULL,
				remote_id VARCHAR(64) NOT NULL DEFAULT '',
				delivery_id VARCHAR(64) NOT NULL,
				payload LONGTEXT NOT NULL,
				status VARCHAR(16) NOT NULL DEFAULT 'pending',
				attempts SMALLINT UNSIGNED NOT NULL DEFAULT 0,
				last_error TEXT NULL,
				created_at DATETIME NOT NULL,
				updated_at DATETIME NOT NULL,
				PRIMARY KEY  (id),
				UNIQUE KEY delivery_id (delivery_id),
				KEY status_created (status, created_at)
			) {$charset};"
		);
	}

	/**
	 * Queue one event.
	 *
	 * Keyed on (topic, remote_id) while still pending: a product saved five
	 * times in a minute is one pending row carrying the latest state, not five
	 * that each cost a round trip to say the same thing. An already-sent row is
	 * never touched — it is the record that the earlier state *was* delivered.
	 */
	public static function enqueue( $topic, $remote_id, array $payload ) {
		global $wpdb;
		$table = self::table_name();
		$now   = current_time( 'mysql', true );

		$existing = $wpdb->get_var(
			$wpdb->prepare(
				"SELECT id FROM {$table} WHERE topic = %s AND remote_id = %s AND status = 'pending' LIMIT 1",
				$topic,
				(string) $remote_id
			)
		);

		if ( $existing ) {
			$wpdb->update(
				$table,
				array(
					'payload'    => wp_json_encode( $payload ),
					'updated_at' => $now,
				),
				array( 'id' => $existing ),
				array( '%s', '%s' ),
				array( '%d' )
			);
			return (int) $existing;
		}

		$wpdb->insert(
			$table,
			array(
				'topic'       => $topic,
				'remote_id'   => (string) $remote_id,
				'delivery_id' => wp_generate_uuid4(),
				'payload'     => wp_json_encode( $payload ),
				'status'      => 'pending',
				'attempts'    => 0,
				'created_at'  => $now,
				'updated_at'  => $now,
			),
			array( '%s', '%s', '%s', '%s', '%s', '%d', '%s', '%s' )
		);
		return (int) $wpdb->insert_id;
	}

	/** The next batch to send, oldest first so events reach the app in the order they happened. */
	public static function due( $limit = 50 ) {
		global $wpdb;
		$table = self::table_name();
		return $wpdb->get_results(
			$wpdb->prepare(
				"SELECT * FROM {$table} WHERE status = 'pending' ORDER BY id ASC LIMIT %d",
				$limit
			),
			ARRAY_A
		);
	}

	public static function mark_sent( array $ids ) {
		if ( empty( $ids ) ) {
			return;
		}
		global $wpdb;
		$table        = self::table_name();
		$placeholders = implode( ',', array_fill( 0, count( $ids ), '%d' ) );
		$params       = array_merge( array( current_time( 'mysql', true ) ), array_map( 'intval', $ids ) );
		$wpdb->query(
			$wpdb->prepare(
				"UPDATE {$table} SET status = 'sent', last_error = NULL, updated_at = %s WHERE id IN ({$placeholders})",
				$params
			)
		);
	}

	/**
	 * Record a failed attempt, giving up after MAX_ATTEMPTS.
	 *
	 * A failed row is left in the table rather than deleted: "this order never
	 * reached the accounting system, and here is why" is exactly what someone
	 * reconciling a missing sale needs to find.
	 */
	public static function mark_failed( $id, $error ) {
		global $wpdb;
		$table = self::table_name();
		$wpdb->query(
			$wpdb->prepare(
				"UPDATE {$table}
					SET attempts = attempts + 1,
						last_error = %s,
						status = CASE WHEN attempts + 1 >= %d THEN 'failed' ELSE 'pending' END,
						updated_at = %s
					WHERE id = %d",
				(string) $error,
				self::MAX_ATTEMPTS,
				current_time( 'mysql', true ),
				(int) $id
			)
		);
	}

	/** Put a permanently-failed row back in line — the "retry" button on the admin screen. */
	public static function retry_failed() {
		global $wpdb;
		$table = self::table_name();
		return (int) $wpdb->query(
			$wpdb->prepare(
				"UPDATE {$table} SET status = 'pending', attempts = 0, updated_at = %s WHERE status = 'failed'",
				current_time( 'mysql', true )
			)
		);
	}

	/** Counts by status, for the admin screen's summary line. */
	public static function counts() {
		global $wpdb;
		$table = self::table_name();
		$rows  = $wpdb->get_results( "SELECT status, COUNT(*) AS total FROM {$table} GROUP BY status", ARRAY_A );
		$out   = array(
			'pending' => 0,
			'sent'    => 0,
			'failed'  => 0,
		);
		foreach ( (array) $rows as $row ) {
			$out[ $row['status'] ] = (int) $row['total'];
		}
		return $out;
	}

	/**
	 * Drop delivered rows older than a month.
	 *
	 * They have served their purpose once the app has them, and an e-commerce
	 * store generates enough of them that keeping every one forever turns a
	 * support table into the largest one in the database.
	 */
	public static function prune() {
		global $wpdb;
		$table = self::table_name();
		$wpdb->query(
			$wpdb->prepare(
				"DELETE FROM {$table} WHERE status = 'sent' AND updated_at < %s",
				gmdate( 'Y-m-d H:i:s', time() - 30 * DAY_IN_SECONDS )
			)
		);
	}
}
