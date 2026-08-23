<?php
/**
 * Two-way sync.
 *
 * **WordPress -> POS.** WooCommerce hooks observe what happens in the store and
 * enqueue it. Nothing is sent from inside a hook — see class-pos-queue.php for
 * why putting an HTTP call in the checkout request is not an option.
 *
 * **POS -> WordPress.** The cron run leases jobs from the app and applies them
 * to WooCommerce: stock levels, prices, and requests for a full catalogue or
 * customer export. Every job is acked, so the app knows what landed and what
 * to retry.
 *
 * The payloads are deliberately WooCommerce's own REST shapes (`id`,
 * `line_items`, `regular_price`, `billing`). The app already knows how to read
 * those — it has been ingesting them from webhooks since the REST integration
 * shipped — so both connection modes feed one ingest path, and a store can
 * migrate from one mode to the other without a single order changing shape.
 */

defined( 'ABSPATH' ) || exit;

class POS_Connector_Sync {

	/** Guards against a hook firing twice in one request for the same object. */
	private static $seen = array();

	public static function init() {
		add_action( POS_CONNECTOR_CRON_HOOK, array( __CLASS__, 'run' ) );

		$settings = pos_connector_settings();
		if ( empty( $settings['enabled'] ) ) {
			return;
		}

		if ( ! empty( $settings['sync_orders'] ) ) {
			// `woocommerce_new_order` fires for admin-created orders too, and
			// `checkout_order_processed` for the storefront path; both funnel
			// here, and the app's delivery-id dedup makes the overlap free.
			add_action( 'woocommerce_new_order', array( __CLASS__, 'on_order_changed' ), 20, 1 );
			add_action( 'woocommerce_checkout_order_processed', array( __CLASS__, 'on_order_changed' ), 20, 1 );
			add_action( 'woocommerce_order_status_changed', array( __CLASS__, 'on_order_status_changed' ), 20, 4 );
			add_action( 'woocommerce_order_refunded', array( __CLASS__, 'on_order_refunded' ), 20, 2 );
		}

		if ( ! empty( $settings['sync_products'] ) ) {
			add_action( 'woocommerce_update_product', array( __CLASS__, 'on_product_changed' ), 20, 1 );
			add_action( 'woocommerce_new_product', array( __CLASS__, 'on_product_changed' ), 20, 1 );
		}

		if ( ! empty( $settings['sync_customers'] ) ) {
			add_action( 'woocommerce_created_customer', array( __CLASS__, 'on_customer_changed' ), 20, 1 );
			add_action( 'woocommerce_update_customer', array( __CLASS__, 'on_customer_changed' ), 20, 1 );
		}
	}

	// -----------------------------------------------------------------------
	// WordPress -> POS: observe and enqueue
	// -----------------------------------------------------------------------

	public static function on_order_changed( $order_id ) {
		self::enqueue_order( $order_id, 'order.created' );
	}

	/**
	 * A status change is sent as `order.updated` — except the transition into a
	 * paid state, which is sent as `order.created`.
	 *
	 * That is not a quirk: the app records an online order as a completed sale
	 * with its payment, so the event that *should* create it is the one where
	 * money actually moved, not the one where a pending cart row appeared.
	 */
	public static function on_order_status_changed( $order_id, $from, $to, $order = null ) {
		$paid_states = array( 'processing', 'completed' );
		$topic       = in_array( $to, $paid_states, true ) && ! in_array( $from, $paid_states, true )
			? 'order.created'
			: 'order.updated';
		self::enqueue_order( $order_id, $topic );
	}

	public static function on_order_refunded( $order_id, $refund_id ) {
		$refund = wc_get_order( $refund_id );
		if ( ! $refund ) {
			return;
		}
		POS_Connector_Queue::enqueue( 'refund.created', $refund_id, self::refund_payload( $refund, $order_id ) );
	}

	public static function on_product_changed( $product_id ) {
		if ( self::already_seen( 'product', $product_id ) ) {
			return;
		}
		$product = wc_get_product( $product_id );
		if ( ! $product ) {
			return;
		}
		POS_Connector_Queue::enqueue( 'product.updated', $product_id, self::product_payload( $product ) );
	}

	public static function on_customer_changed( $customer_id ) {
		if ( self::already_seen( 'customer', $customer_id ) ) {
			return;
		}
		$customer = new WC_Customer( $customer_id );
		if ( ! $customer->get_id() ) {
			return;
		}
		POS_Connector_Queue::enqueue( 'customer.updated', $customer_id, self::customer_payload( $customer ) );
	}

	private static function already_seen( $kind, $id ) {
		$key = $kind . ':' . $id;
		if ( isset( self::$seen[ $key ] ) ) {
			return true;
		}
		self::$seen[ $key ] = true;
		return false;
	}

	private static function enqueue_order( $order_id, $topic ) {
		$order = wc_get_order( $order_id );
		if ( ! $order || $order->get_status() === 'trash' ) {
			return;
		}
		POS_Connector_Queue::enqueue( $topic, $order_id, self::order_payload( $order ) );
	}

	// -----------------------------------------------------------------------
	// Payload builders — WooCommerce REST shapes, as the app already reads them
	// -----------------------------------------------------------------------

	public static function order_payload( $order ) {
		$items = array();
		foreach ( $order->get_items() as $item ) {
			$product = $item->get_product();
			$items[] = array(
				'id'         => $item->get_id(),
				'product_id' => $product ? $product->get_id() : 0,
				'name'       => $item->get_name(),
				'quantity'   => (int) $item->get_quantity(),
				'total'      => (string) $item->get_total(),
				'total_tax'  => (string) $item->get_total_tax(),
				'sku'        => $product ? $product->get_sku() : '',
			);
		}

		return array(
			'id'             => $order->get_id(),
			'number'         => $order->get_order_number(),
			'status'         => $order->get_status(),
			'currency'       => $order->get_currency(),
			'total'          => (string) $order->get_total(),
			'total_tax'      => (string) $order->get_total_tax(),
			'shipping_total' => (string) $order->get_shipping_total(),
			'discount_total' => (string) $order->get_discount_total(),
			'payment_method' => $order->get_payment_method(),
			'date_created'   => $order->get_date_created() ? $order->get_date_created()->date( DATE_ATOM ) : null,
			'date_paid'      => $order->get_date_paid() ? $order->get_date_paid()->date( DATE_ATOM ) : null,
			'customer_id'    => $order->get_customer_id(),
			'billing'        => array(
				'first_name' => $order->get_billing_first_name(),
				'last_name'  => $order->get_billing_last_name(),
				'phone'      => $order->get_billing_phone(),
				'email'      => $order->get_billing_email(),
				'address_1'  => $order->get_billing_address_1(),
				'city'       => $order->get_billing_city(),
			),
			'line_items'     => $items,
		);
	}

	public static function refund_payload( $refund, $parent_order_id ) {
		$items = array();
		foreach ( $refund->get_items() as $item ) {
			$product = $item->get_product();
			$items[] = array(
				'id'         => $item->get_id(),
				'product_id' => $product ? $product->get_id() : 0,
				'name'       => $item->get_name(),
				// WooCommerce stores refunded quantities and totals as negative
				// numbers; the app expects the magnitude, so they are made
				// positive here rather than in three places on the other side.
				'quantity'   => abs( (int) $item->get_quantity() ),
				'total'      => (string) abs( (float) $item->get_total() ),
			);
		}

		return array(
			'id'         => $refund->get_id(),
			'order_id'   => (int) $parent_order_id,
			'amount'     => (string) abs( (float) $refund->get_amount() ),
			'reason'     => $refund->get_reason(),
			'date_created' => $refund->get_date_created() ? $refund->get_date_created()->date( DATE_ATOM ) : null,
			'line_items' => $items,
		);
	}

	/**
	 * One product or variation's full identity, enough for the app to build an
	 * `items` row (retail) or a `menu_items` row (F&B) from it.
	 *
	 * A variable product's children are NOT embedded here — get_variation_ids
	 * during an export async-calls get_product for each child, so embedding
	 * them in the parent payload would (a) risk a timeout for a product with
	 * 100 SKU and (b) produce stale children when `woocommerce_update_product`
	 * fires only for the parent. Instead, the export loop enqueues a separate
	 * `product.variation` event for each child, and `product.updated` on a
	 * variable parent only carries the parent-level fields (name, sku,
	 * attributes) the app already needs to create `variant_parent` items.
	 */
	public static function product_payload( $product ) {
		$type         = $product->get_type();
		$parent_id    = $product->get_parent_id();
		$description  = $product->get_description();
		$short_desc   = $product->get_short_description();
		$stock_status = $product->get_stock_status();

		// Attributes: the named options a variable product defines (parent) and
		// the concrete selections a variation picks (child). Standard shapes
		// from WooCommerce's own REST API, which the app's TS types mirror.
		$attributes = array();
		foreach ( $product->get_attributes() as $attr ) {
			$attributes[] = array(
				'id'        => $attr->get_id(),
				'name'      => $attr->get_name(),
				'position'  => $attr->get_position(),
				'visible'   => (bool) $attr->get_visible(),
				'variation' => (bool) $attr->get_variation(),
				'options'   => $attr->get_options(),
			);
		}

		// Categories: a flat array of {id, name, slug} triples.
		$categories = array();
		foreach ( wp_get_post_terms( $product->get_id(), 'product_cat' ) as $term ) {
			$categories[] = array(
				'id'   => $term->term_id,
				'name' => $term->name,
				'slug' => $term->slug,
			);
		}

		// Images: the main image plus gallery, each as {id, src, alt}.
		$images = array();
		$image_id = $product->get_image_id();
		if ( $image_id ) {
			$src = wp_get_attachment_url( $image_id );
			$alt = get_post_meta( $image_id, '_wp_attachment_image_alt', true );
			$images[] = array( 'id' => $image_id, 'src' => $src ? $src : '', 'alt' => $alt ? $alt : '', 'position' => 0 );
		}
		foreach ( $product->get_gallery_image_ids() as $idx => $gallery_id ) {
			$src = wp_get_attachment_url( $gallery_id );
			$alt = get_post_meta( $gallery_id, '_wp_attachment_image_alt', true );
			$images[] = array( 'id' => $gallery_id, 'src' => $src ? $src : '', 'alt' => $alt ? $alt : '', 'position' => $idx + 1 );
		}

		// Variation-specific fields, only present when $type === 'variation'.
		$variation_attributes = array();
		if ( 'variation' === $type ) {
			foreach ( $product->get_variation_attributes() as $key => $value ) {
				$variation_attributes[] = array(
					'name'  => wc_attribute_label( str_replace( 'attribute_', '', $key ) ),
					'option' => $value,
				);
			}
		}

		$payload = array(
			'id'             => $product->get_id(),
			'type'           => $type,
			'name'           => $product->get_name(),
			'sku'            => $product->get_sku(),
			'price'          => (string) $product->get_price(),
			'regular_price'  => (string) $product->get_regular_price(),
			'sale_price'     => (string) $product->get_sale_price(),
			'stock_quantity' => $product->get_stock_quantity(),
			'manage_stock'   => (bool) $product->get_manage_stock(),
			'stock_status'   => $stock_status,
			'status'         => $product->get_status(),
			'description'    => $description,
			'short_description' => $short_desc,
			'permalink'      => get_permalink( $product->get_id() ),
			'attributes'      => $attributes,
			'categories'      => $categories,
			'images'          => $images,
		);

		if ( $parent_id ) {
			$payload['parent_id'] = $parent_id;
		}

		if ( 'variation' === $type && ! empty( $variation_attributes ) ) {
			$payload['variation_attributes'] = $variation_attributes;
		}

		return $payload;
	}

	public static function customer_payload( $customer ) {
		return array(
			'id'         => $customer->get_id(),
			'email'      => $customer->get_email(),
			'first_name' => $customer->get_first_name(),
			'last_name'  => $customer->get_last_name(),
			'billing'    => array(
				'phone'     => $customer->get_billing_phone(),
				'address_1' => $customer->get_billing_address_1(),
				'city'      => $customer->get_billing_city(),
			),
		);
	}

	// -----------------------------------------------------------------------
	// The scheduled run
	// -----------------------------------------------------------------------

	/**
	 * One full cycle: say hello, push what is queued, pull and apply what is
	 * waiting.
	 *
	 * Ordered that way deliberately. The handshake refreshes the settings the
	 * push then honours; pushing before pulling means a stock level the app
	 * computes is computed from sales it already knows about, rather than from
	 * a picture one cycle out of date.
	 */
	public static function run() {
		$settings = pos_connector_settings();
		if ( empty( $settings['enabled'] ) ) {
			return;
		}

		$client = POS_Connector_Client::from_settings();
		if ( ! $client ) {
			POS_Connector_Log::error( 'run', 'not_configured' );
			return;
		}

		$handshake = self::handshake( $client );
		if ( ! $handshake['ok'] ) {
			pos_connector_update_settings( array( 'last_error' => POS_Connector_Client::explain( $handshake['error'] ) ) );
			POS_Connector_Log::error( 'handshake', $handshake['error'] );
			return;
		}

		self::push_queue( $client );
		self::pull_jobs( $client );

		pos_connector_update_settings(
			array(
				'last_ok_at'  => current_time( 'mysql', true ),
				'last_error'  => '',
			)
		);
		POS_Connector_Queue::prune();
		POS_Connector_Log::prune();
	}

	/**
	 * Introduce this site and take back the connection's current settings.
	 *
	 * The sync toggles live in the accounting dashboard, so this is how a
	 * change made there reaches WordPress — nobody has to configure the same
	 * switch twice, and the two sides cannot disagree about what is being
	 * synced.
	 */
	public static function handshake( POS_Connector_Client $client ) {
		$response = $client->post(
			'/api/integrations/wordpress/handshake',
			array(
				'siteUrl'       => home_url(),
				'pluginVersion' => POS_CONNECTOR_VERSION,
			)
		);
		if ( ! $response['ok'] ) {
			return $response;
		}

		$connection = isset( $response['data']['connection'] ) ? $response['data']['connection'] : array();
		if ( $connection ) {
			pos_connector_update_settings(
				array(
					'sync_orders'    => ! empty( $connection['syncOrders'] ),
					'sync_products'  => ! empty( $connection['syncProducts'] ),
					'sync_customers' => ! empty( $connection['syncCustomers'] ),
					'apply_stock'    => ! empty( $connection['pushStock'] ),
					'apply_prices'   => ! empty( $connection['pushPrices'] ),
				)
			);
		}
		return $response;
	}

	/** Send queued events in batches, marking each row by what the app said about it. */
	public static function push_queue( POS_Connector_Client $client ) {
		$rows = POS_Connector_Queue::due( 50 );
		if ( empty( $rows ) ) {
			return;
		}

		$events = array();
		$by_id  = array();
		foreach ( $rows as $row ) {
			$events[] = array(
				'topic'      => $row['topic'],
				'deliveryId' => $row['delivery_id'],
				'payload'    => json_decode( $row['payload'], true ),
			);
			$by_id[ $row['delivery_id'] ] = (int) $row['id'];
		}

		$response = $client->post( '/api/integrations/wordpress/events', array( 'events' => $events ) );
		if ( ! $response['ok'] ) {
			// The whole batch failed to be *delivered* — not to be applied — so
			// every row keeps its place in the queue and gets another attempt.
			foreach ( $by_id as $id ) {
				POS_Connector_Queue::mark_failed( $id, $response['error'] );
			}
			POS_Connector_Log::error( 'push', $response['error'] );
			return;
		}

		$sent   = array();
		$failed = 0;
		foreach ( (array) ( isset( $response['data']['results'] ) ? $response['data']['results'] : array() ) as $result ) {
			$delivery_id = isset( $result['deliveryId'] ) ? $result['deliveryId'] : '';
			if ( ! isset( $by_id[ $delivery_id ] ) ) {
				continue;
			}
			// "duplicate" is a success: the app already has this event, which is
			// exactly what a retry after a timeout is supposed to discover.
			if ( isset( $result['status'] ) && in_array( $result['status'], array( 'processed', 'duplicate' ), true ) ) {
				$sent[] = $by_id[ $delivery_id ];
			} else {
				++$failed;
				POS_Connector_Queue::mark_failed( $by_id[ $delivery_id ], isset( $result['error'] ) ? $result['error'] : 'rejected' );
			}
		}

		POS_Connector_Queue::mark_sent( $sent );
		POS_Connector_Log::info( 'push', sprintf( 'ارسال‌شده: %d، ناموفق: %d', count( $sent ), $failed ) );
	}

	/** Lease jobs from the app, apply each to WooCommerce, and report back. */
	public static function pull_jobs( POS_Connector_Client $client ) {
		$response = $client->post( '/api/integrations/wordpress/jobs' );
		if ( ! $response['ok'] ) {
			POS_Connector_Log::error( 'pull', $response['error'] );
			return;
		}

		$jobs = isset( $response['data']['jobs'] ) ? (array) $response['data']['jobs'] : array();
		if ( empty( $jobs ) ) {
			return;
		}

		$results = array();
		foreach ( $jobs as $job ) {
			try {
				self::apply_job( $job );
				$results[] = array(
					'id'     => $job['id'],
					'status' => 'done',
				);
			} catch ( Exception $e ) {
				$results[] = array(
					'id'     => $job['id'],
					'status' => 'failed',
					'error'  => $e->getMessage(),
				);
				POS_Connector_Log::error( 'job:' . $job['type'], $e->getMessage() );
			}
		}

		$client->post( '/api/integrations/wordpress/jobs/ack', array( 'results' => $results ) );
		POS_Connector_Log::info( 'pull', sprintf( 'کار دریافتی: %d', count( $jobs ) ) );
	}

	/**
	 * Apply one job.
	 *
	 * Throws on failure rather than returning a flag: the caller turns a thrown
	 * message into the `failed` ack, and a job that half-applied must not be
	 * reported as done.
	 */
	private static function apply_job( array $job ) {
		$settings = pos_connector_settings();
		$type     = isset( $job['type'] ) ? $job['type'] : '';
		$payload  = isset( $job['payload'] ) && is_array( $job['payload'] ) ? $job['payload'] : array();

		switch ( $type ) {
			case 'stock':
				if ( empty( $settings['apply_stock'] ) ) {
					// The owner switched this off on the accounting side. Acking
					// as done rather than failed is right: nothing went wrong,
					// and failing would retry it six times before dead-lettering.
					return;
				}
				$product = wc_get_product( (int) $job['remoteId'] );
				if ( ! $product ) {
					throw new Exception( 'product_not_found' );
				}
				if ( ! array_key_exists( 'stock_quantity', $payload ) ) {
					throw new Exception( 'missing_stock_quantity' );
				}
				$product->set_manage_stock( true );
				$product->set_stock_quantity( (int) $payload['stock_quantity'] );
				$product->save();
				return;

			case 'price':
				if ( empty( $settings['apply_prices'] ) ) {
					return;
				}
				$product = wc_get_product( (int) $job['remoteId'] );
				if ( ! $product ) {
					throw new Exception( 'product_not_found' );
				}
				if ( ! array_key_exists( 'regular_price', $payload ) ) {
					throw new Exception( 'missing_regular_price' );
				}
				$product->set_regular_price( (string) $payload['regular_price'] );
				// A sale price above the new regular price would silently keep
				// the old, lower number in front of customers.
				if ( '' !== $product->get_sale_price() && (float) $product->get_sale_price() > (float) $payload['regular_price'] ) {
					$product->set_sale_price( '' );
				}
				$product->save();
				return;

			case 'catalogue_export':
				self::export_products();
				return;

			case 'customer_export':
				self::export_customers();
				return;

			default:
				// An unknown job type from a newer server. Acking it as done
				// rather than failing keeps an older plugin from dead-lettering
				// work it simply does not understand yet.
				POS_Connector_Log::info( 'job:unknown', $type );
		}
	}

	/**
	 * Send the whole catalogue as ordinary product events.
	 *
	 * This is what "همگام‌سازی محصولات" does in plugin mode: the app cannot read
	 * the store, so it asks, and the answer arrives through the same event path
	 * a single product edit uses. Queued rather than posted directly, so it
	 * inherits the queue's batching and retry instead of trying to push a
	 * thousand products inside one cron run.
	 *
	 * Simple and variable-parent products are queried first, then variations
	 * separately — `wc_get_products` does not return variations unless
	 * explicitly asked with `type=>'variation'`, and a variable product's
	 * children are the sellable units (each with its own stock, price and SKU)
	 * that a missing variation query would silently skip.
	 */
	private static function export_products() {
		// Pass 1: simple and variable-parent products.
		$page = 1;
		do {
			$products = wc_get_products(
				array(
					'limit'  => 100,
					'page'   => $page,
					'status' => 'publish',
					'type'   => array( 'simple', 'variable' ),
					'return' => 'objects',
				)
			);
			foreach ( $products as $product ) {
				POS_Connector_Queue::enqueue( 'product.updated', $product->get_id(), self::product_payload( $product ) );
			}
			++$page;
		} while ( count( $products ) === 100 );

		// Pass 2: variations — the sellable children under variable products.
		$page = 1;
		do {
			$variations = wc_get_products(
				array(
					'limit'  => 100,
					'page'   => $page,
					'status' => 'publish',
					'type'   => 'variation',
					'return' => 'objects',
				)
			);
			foreach ( $variations as $variation ) {
				POS_Connector_Queue::enqueue( 'product.updated', $variation->get_id(), self::product_payload( $variation ) );
			}
			++$page;
		} while ( count( $variations ) === 100 );

		POS_Connector_Log::info( 'export', 'محصولات در صف ارسال قرار گرفتند.' );
	}

	private static function export_customers() {
		$paged = 1;
		do {
			$users = get_users(
				array(
					'role'   => 'customer',
					'number' => 100,
					'paged'  => $paged,
					'fields' => 'ID',
				)
			);
			foreach ( $users as $user_id ) {
				$customer = new WC_Customer( $user_id );
				if ( $customer->get_id() ) {
					POS_Connector_Queue::enqueue( 'customer.updated', $user_id, self::customer_payload( $customer ) );
				}
			}
			++$paged;
		} while ( count( $users ) === 100 );

		POS_Connector_Log::info( 'export', 'مشتریان در صف ارسال قرار گرفتند.' );
	}
}
