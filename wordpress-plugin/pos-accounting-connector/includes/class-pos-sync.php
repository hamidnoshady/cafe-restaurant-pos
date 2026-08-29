<?php
/**
 * Two-way sync.
 *
 * **WordPress -> POS.** WooCommerce hooks observe what happens in the store and
 * enqueue it. Nothing is sent from inside a hook — see class-pos-queue.php for
 * why putting an HTTP call in the checkout request is not an option.
 *
 * **POS -> WordPress.** The cron run leases jobs from the app and applies them
 * to WooCommerce: stock levels, prices, whole-product updates, order statuses
 * and refunds; plus requests for a full catalogue, customer or order export.
 * Every job is acked, so the app knows what landed and what to retry.
 *
 * The payloads are deliberately WooCommerce's own REST shapes (`id`,
 * `line_items`, `regular_price`, `billing`). The app already knows how to read
 * those — it has been ingesting them from webhooks since the REST integration
 * shipped — so both connection modes feed one ingest path, and a store can
 * migrate from one mode to the other without a single order changing shape.
 *
 * ## The order-line fix (1.1.0)
 *
 * An order line used to carry `product_id` only. That looked harmless and was
 * not: for a variable product, `WC_Order_Item_Product::get_product()` returns
 * the *variation*, so this plugin sent the variation's id in `product_id` —
 * while a WooCommerce webhook sends the parent's id there and the variation's
 * id in `variation_id`. The same order, in the same app, resolved to two
 * different products depending on how the store was connected.
 *
 * Both ids are now sent, with WooCommerce's own names, and the app resolves
 * `variation_id` first. One shape, one answer, both doors.
 */

defined( 'ABSPATH' ) || exit;

class POS_Connector_Sync {

	/** Guards against a hook firing twice in one request for the same object. */
	private static $seen = array();

	/** How many orders one sweep may re-send, so a cron run finishes inside PHP's limit. */
	const ORDER_SWEEP_LIMIT = 200;

	public static function init() {
		add_action( POS_CONNECTOR_CRON_HOOK, array( __CLASS__, 'run' ) );
		add_action( POS_CONNECTOR_CRON_RESYNC_PRODUCTS, array( __CLASS__, 'run_resync_products' ) );
		add_action( POS_CONNECTOR_CRON_RESYNC_ORDERS, array( __CLASS__, 'run_resync_orders' ) );

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
			// A variation saved on its own (from the product data metabox, or
			// by a bulk editor) fires no parent hook at all, so without this
			// a price changed on one variation never reached the app.
			add_action( 'woocommerce_new_product_variation', array( __CLASS__, 'on_product_changed' ), 20, 1 );
			add_action( 'woocommerce_update_product_variation', array( __CLASS__, 'on_product_changed' ), 20, 1 );
			// A variation deleted leaves the app holding a sellable row for
			// something the store no longer sells. Push the parent so the app
			// can reconcile the family.
			add_action( 'woocommerce_delete_product_variation', array( __CLASS__, 'on_variation_deleted' ), 20, 1 );
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

		// A variable product saved from the admin screen rewrites all of its
		// children, and WooCommerce fires no hook for the ones it changed.
		// Enqueue them here, because a variation's price is the one number
		// the app must not be stale about.
		if ( $product->is_type( 'variable' ) ) {
			self::enqueue_variations( $product->get_id() );
		}
	}

	/**
	 * A variation was deleted. Send its parent, not the variation.
	 *
	 * There is no payload to send for something that no longer exists, but the
	 * app is still mapping a sellable row to that variation id. A parent push
	 * is the signal to reconcile the family without a second event type.
	 */
	public static function on_variation_deleted( $variation_id ) {
		$variation = wc_get_product( $variation_id );
		$parent_id = $variation ? $variation->get_parent_id() : 0;
		if ( ! $parent_id ) {
			// The row is already gone; fall back to the post's parent.
			$post = get_post( $variation_id );
			$parent_id = $post ? (int) $post->post_parent : 0;
		}
		if ( ! $parent_id ) {
			return;
		}
		$parent = wc_get_product( $parent_id );
		if ( ! $parent ) {
			return;
		}
		POS_Connector_Queue::enqueue( 'product.updated', $parent_id, self::product_payload( $parent ) );
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

	/** Queue every child of a variable product as its own event. */
	private static function enqueue_variations( $parent_id ) {
		$children = wc_get_products(
			array(
				'parent' => $parent_id,
				'type'   => 'variation',
				'limit'  => -1,
				'return' => 'ids',
			)
		);
		foreach ( $children as $child_id ) {
			$child = wc_get_product( $child_id );
			if ( $child ) {
				POS_Connector_Queue::enqueue( 'product.updated', $child_id, self::product_payload( $child ) );
			}
		}
	}

	// -----------------------------------------------------------------------
	// Payload builders — WooCommerce REST shapes, as the app already reads them
	// -----------------------------------------------------------------------

	/**
	 * One order, in WooCommerce's own REST shape.
	 *
	 * Every line carries `product_id` **and** `variation_id`, named exactly as
	 * WooCommerce's REST API names them. `WC_Order_Item_Product::get_product()`
	 * returns the variation when there is one, so a payload built from it alone
	 * put the variation's id in `product_id` — the opposite of what a webhook
	 * for the same order sends. See the class comment.
	 */
	public static function order_payload( $order ) {
		$items = array();
		foreach ( $order->get_items() as $item ) {
			if ( ! is_callable( array( $item, 'get_product_id' ) ) ) {
				continue;
			}
			$product      = $item->get_product();
			$product_id   = (int) $item->get_product_id();
			$variation_id = (int) $item->get_variation_id();

			// Some extensions build line items without setting the parent id.
			// Deriving it from the product keeps the two doors agreeing even
			// then, rather than emitting a variation with no parent at all.
			if ( $variation_id > 0 && $product_id <= 0 && $product ) {
				$product_id = (int) $product->get_parent_id();
			}

			$items[] = array(
				'id'           => $item->get_id(),
				'product_id'   => $product_id,
				'variation_id' => $variation_id,
				'name'         => $item->get_name(),
				'quantity'     => (int) $item->get_quantity(),
				'price'        => (string) $item->get_subtotal(),
				'total'        => (string) $item->get_total(),
				'subtotal'     => (string) $item->get_subtotal(),
				'total_tax'    => (string) $item->get_total_tax(),
				'sku'          => $product ? $product->get_sku() : '',
				// The parent's name, so the app can label a variation line the
				// way the customer saw it.
				'parent_name'  => $product && $product->get_parent_id() ? get_the_title( $product->get_parent_id() ) : '',
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
			'date_modified'  => $order->get_date_modified() ? $order->get_date_modified()->date( DATE_ATOM ) : null,
			'customer_id'    => $order->get_customer_id(),
			'billing'        => array(
				'first_name' => $order->get_billing_first_name(),
				'last_name'  => $order->get_billing_last_name(),
				'phone'      => $order->get_billing_phone(),
				'email'      => $order->get_billing_email(),
				'company'    => $order->get_billing_company(),
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
				'id'           => $item->get_id(),
				'product_id'   => is_callable( array( $item, 'get_product_id' ) ) ? (int) $item->get_product_id() : ( $product ? $product->get_id() : 0 ),
				'variation_id' => is_callable( array( $item, 'get_variation_id' ) ) ? (int) $item->get_variation_id() : 0,
				'name'         => $item->get_name(),
				// WooCommerce stores refunded quantities and totals as negative
				// numbers; the app expects the magnitude, so they are made
				// positive here rather than in three places on the other side.
				'quantity'     => abs( (int) $item->get_quantity() ),
				'total'        => (string) abs( (float) $item->get_total() ),
			);
		}

		return array(
			'id'           => $refund->get_id(),
			'order_id'     => (int) $parent_order_id,
			'parent_id'    => (int) $parent_order_id,
			'amount'       => (string) abs( (float) $refund->get_amount() ),
			'reason'       => $refund->get_reason(),
			'date_created' => $refund->get_date_created() ? $refund->get_date_created()->date( DATE_ATOM ) : null,
			'line_items'   => $items,
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
	 * `product.updated` event for each child, and `product.updated` on a
	 * variable parent only carries the parent-level fields (name, sku,
	 * attributes) the app already needs to create `variant_parent` items.
	 */
	public static function product_payload( $product ) {
		$type         = $product->get_type();
		$parent_id    = (int) $product->get_parent_id();
		$description  = $product->get_description();
		$short_desc   = $product->get_short_description();
		$stock_status = $product->get_stock_status();

		// Attributes: the named options a variable product defines (parent) and
		// the concrete selections a variation picks (child). Standard shapes
		// from WooCommerce's own REST API, which the app's TS types mirror.
		$attributes = array();
		foreach ( $product->get_attributes() as $attr ) {
			if ( is_array( $attr ) ) {
				// A variation's attributes come back as name => value pairs
				// from some WooCommerce versions rather than as objects.
				$attributes[] = array(
					'id'        => 0,
					'name'      => isset( $attr['name'] ) ? $attr['name'] : '',
					'position'  => 0,
					'visible'   => true,
					'variation' => true,
					'options'   => isset( $attr['value'] ) ? array_map( 'trim', explode( ',', $attr['value'] ) ) : array(),
				);
				continue;
			}
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

		// Tags, so the app's taxonomy mirror is not half a tree.
		$tags = array();
		foreach ( wp_get_post_terms( $product->get_id(), 'product_tag' ) as $term ) {
			$tags[] = array(
				'id'   => $term->term_id,
				'name' => $term->name,
				'slug' => $term->slug,
			);
		}

		// Images: the main image plus gallery, each as {id, src, alt}.
		$images   = array();
		$image_id = $product->get_image_id();
		if ( $image_id ) {
			$src      = wp_get_attachment_url( $image_id );
			$alt      = get_post_meta( $image_id, '_wp_attachment_image_alt', true );
			$images[] = array( 'id' => $image_id, 'src' => $src ? $src : '', 'alt' => $alt ? $alt : '', 'position' => 0 );
		}
		foreach ( $product->get_gallery_image_ids() as $idx => $gallery_id ) {
			$src    = wp_get_attachment_url( $gallery_id );
			$alt    = get_post_meta( $gallery_id, '_wp_attachment_image_alt', true );
			$images[] = array( 'id' => $gallery_id, 'src' => $src ? $src : '', 'alt' => $alt ? $alt : '', 'position' => $idx + 1 );
		}

		// Variation-specific fields, only present when $type === 'variation'.
		$variation_attributes = array();
		if ( 'variation' === $type ) {
			foreach ( $product->get_variation_attributes() as $key => $value ) {
				$variation_attributes[] = array(
					'name'   => wc_attribute_label( str_replace( 'attribute_', '', $key ) ),
					// An empty value means "any of them" in WooCommerce's own
					// UI; sending it as a blank attribute would make the app
					// name a variation «تی‌شرت • رنگ: ».
					'option' => '' === $value ? __( 'هر کدام', 'pos-accounting-connector' ) : $value,
				);
			}
		}

		$payload = array(
			'id'               => $product->get_id(),
			'type'             => $type,
			'name'             => $product->get_name(),
			'sku'              => $product->get_sku(),
			'price'            => (string) $product->get_price(),
			'regular_price'    => (string) $product->get_regular_price(),
			'sale_price'       => (string) $product->get_sale_price(),
			'stock_quantity'   => $product->get_stock_quantity(),
			'manage_stock'     => (bool) $product->get_manage_stock(),
			'stock_status'     => $stock_status,
			'status'           => $product->get_status(),
			'description'      => $description,
			'short_description' => $short_desc,
			'permalink'        => get_permalink( $product->get_id() ),
			'menu_order'       => (int) $product->get_menu_order(),
			'date_modified'    => $product->get_date_modified() ? $product->get_date_modified()->date( DATE_ATOM ) : null,
			'attributes'       => $attributes,
			'categories'       => $categories,
			'tags'             => $tags,
			'images'           => $images,
		);

		if ( $parent_id ) {
			$payload['parent_id'] = $parent_id;
		}

		if ( 'variation' === $type && ! empty( $variation_attributes ) ) {
			$payload['variation_attributes'] = $variation_attributes;
		}

		// A variable product's children, as ids. The app uses them only to
		// know how many variations to expect — the children themselves arrive
		// as their own events.
		if ( 'variable' === $type ) {
			$payload['variation_ids'] = array_map( 'intval', $product->get_children() );
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
	// The scheduled runs
	// -----------------------------------------------------------------------

	/**
	 * The fast lane: say hello, push what is queued, pull and apply what is
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

		$stats = array(
			'at'      => current_time( 'mysql', true ),
			'pushed'  => self::push_queue( $client ),
			'applied' => self::pull_jobs( $client ),
		);

		pos_connector_update_settings(
			array(
				'last_ok_at'     => current_time( 'mysql', true ),
				'last_error'     => '',
				'last_run_stats' => $stats,
			)
		);
		POS_Connector_Queue::prune();
		POS_Connector_Log::prune();

		return $stats;
	}

	/**
	 * The catalogue sweep: queue the entire catalogue as ordinary product
	 * events, then run the fast lane so they start going out immediately
	 * rather than waiting for the next tick.
	 */
	public static function run_resync_products() {
		$settings = pos_connector_settings();
		if ( empty( $settings['enabled'] ) || empty( $settings['sync_products'] ) ) {
			return;
		}
		self::export_products();
		pos_connector_update_settings( array( 'last_products_sweep_at' => current_time( 'mysql', true ) ) );
		self::run();
	}

	/**
	 * The order sweep: queue every order changed in the lookback window.
	 *
	 * This is the backstop that makes a missed hook survivable. A sale that
	 * never fired `woocommerce_new_order` — a plugin conflict, a fatal during
	 * checkout, an order created by an importer — is invisible until something
	 * goes looking for it, and this is the something.
	 */
	public static function run_resync_orders() {
		$settings = pos_connector_settings();
		if ( empty( $settings['enabled'] ) || empty( $settings['sync_orders'] ) ) {
			return;
		}
		self::export_orders( (int) $settings['resync_orders_days'] );
		pos_connector_update_settings( array( 'last_orders_sweep_at' => current_time( 'mysql', true ) ) );
		self::run();
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

	/**
	 * Send queued events in batches, marking each row by what the app said
	 * about it. Returns how many were delivered.
	 */
	public static function push_queue( POS_Connector_Client $client ) {
		$rows = POS_Connector_Queue::due( 50 );
		if ( empty( $rows ) ) {
			return 0;
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
			return 0;
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
		return count( $sent );
	}

	/**
	 * Lease jobs from the app, apply each to WooCommerce, and report back.
	 * Returns how many were applied.
	 */
	public static function pull_jobs( POS_Connector_Client $client ) {
		$response = $client->post( '/api/integrations/wordpress/jobs' );
		if ( ! $response['ok'] ) {
			POS_Connector_Log::error( 'pull', $response['error'] );
			return 0;
		}

		$jobs = isset( $response['data']['jobs'] ) ? (array) $response['data']['jobs'] : array();
		if ( empty( $jobs ) ) {
			return 0;
		}

		$results = array();
		$applied = 0;
		foreach ( $jobs as $job ) {
			try {
				self::apply_job( $job );
				$results[] = array(
					'id'     => $job['id'],
					'status' => 'done',
				);
				++$applied;
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
		return $applied;
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
		// A variation's updates must be applied to the variation, which
		// `wc_get_product()` also returns for a variation id — but the parent
		// id is sent precisely so a store with an unusual product class can be
		// sure which object it was given.
		$remote   = isset( $job['remoteId'] ) ? (int) $job['remoteId'] : 0;
		$parent   = isset( $job['parentRemoteId'] ) ? (int) $job['parentRemoteId'] : 0;

		switch ( $type ) {
			case 'stock':
				if ( empty( $settings['apply_stock'] ) ) {
					// The owner switched this off on the accounting side. Acking
					// as done rather than failed is right: nothing went wrong,
					// and failing would retry it six times before dead-lettering.
					return;
				}
				$product = self::product_for_job( $remote, $parent );
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
				$product = self::product_for_job( $remote, $parent );
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

			case 'product_update':
				// A whole-field update from the accounting dashboard. The field
				// list was validated on the app side; here it is applied field
				// by field so an unknown key cannot be written blind.
				$product = self::product_for_job( $remote, $parent );
				$allowed = array(
					'name'              => 'set_name',
					'regular_price'     => 'set_regular_price',
					'sale_price'        => 'set_sale_price',
					'stock_quantity'    => 'set_stock_quantity',
					'manage_stock'      => 'set_manage_stock',
					'status'            => 'set_status',
					'description'       => 'set_description',
					'short_description' => 'set_short_description',
				);
				$applied = false;
				foreach ( $allowed as $field => $setter ) {
					if ( ! array_key_exists( $field, $payload ) ) {
						continue;
					}
					$value = $payload[ $field ];
					if ( 'manage_stock' === $field ) {
						$value = (bool) $value;
					} elseif ( 'stock_quantity' === $field ) {
						$value = (int) $value;
					} else {
						$value = (string) $value;
					}
					$product->{$setter}( $value );
					$applied = true;
				}
				if ( ! $applied ) {
					throw new Exception( 'empty_product_update' );
				}
				$product->save();
				return;

			case 'order_status':
				$order = wc_get_order( $remote );
				if ( ! $order ) {
					throw new Exception( 'order_not_found' );
				}
				if ( ! isset( $payload['status'] ) ) {
					throw new Exception( 'missing_status' );
				}
				// `set_status` does not persist; without an explicit save the
				// change would be acked and then vanish.
				$order->set_status( (string) $payload['status'] );
				$order->save();
				return;

			case 'refund_create':
				$order = wc_get_order( $remote );
				if ( ! $order ) {
					throw new Exception( 'order_not_found' );
				}
				if ( ! isset( $payload['amount'] ) ) {
					throw new Exception( 'missing_amount' );
				}
				// `api_refund` is deliberately forced false: this app records
				// that a refund was agreed, it does not move money through a
				// payment gateway. Crediting a card is the store's business.
				$refund = wc_create_refund(
					array(
						'amount'     => (string) $payload['amount'],
						'reason'     => isset( $payload['reason'] ) ? (string) $payload['reason'] : '',
						'order_id'   => $remote,
						'refund_id'  => 0,
						'restock_items' => true,
					)
				);
				if ( is_wp_error( $refund ) ) {
					throw new Exception( $refund->get_error_message() );
				}
				return;

			case 'catalogue_export':
				self::export_products();
				return;

			case 'customer_export':
				self::export_customers();
				return;

			case 'orders_export':
				self::export_orders( isset( $payload['sinceDays'] ) && $payload['sinceDays'] ? (int) $payload['sinceDays'] : (int) $settings['resync_orders_days'] );
				return;

			default:
				// An unknown job type from a newer server. Acking it as done
				// rather than failing keeps an older plugin from dead-lettering
				// work it simply does not understand yet.
				POS_Connector_Log::info( 'job:unknown', $type );
		}
	}

	/**
	 * The product a job targets, resolving a variation through its parent.
	 *
	 * `wc_get_product()` accepts a variation id and returns the variation, so
	 * the parent is not strictly required — but it is sent, and using it means
	 * a store where a variation id collides with a product id (it happens after
	 * a bad import) still updates the right object.
	 */
	private static function product_for_job( $remote_id, $parent_id = 0 ) {
		$product = wc_get_product( (int) $remote_id );
		if ( $product && $parent_id > 0 && $product->get_parent_id() && (int) $product->get_parent_id() !== $parent_id ) {
			// The id resolved to an object under a different parent than the
			// job named. Trust the parent and re-resolve from it, rather than
			// writing to a variation that happens to share the id.
			$found = null;
			foreach ( wc_get_product( $parent_id )->get_children() as $child_id ) {
				if ( (int) $child_id === (int) $remote_id ) {
					$found = wc_get_product( $child_id );
					break;
				}
			}
			$product = $found ? $found : $product;
		}
		if ( ! $product ) {
			throw new Exception( 'product_not_found' );
		}
		return $product;
	}

	/**
	 * Send the whole catalogue as ordinary product events.
	 *
	 * This is what «همگام‌سازی محصولات» does in plugin mode: the app cannot read
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
	 *
	 * Grouped and external products are included: they are real catalogue rows
	 * with a real type, and leaving them out is what made the app treat an
	 * unrecognised type as "skip".
	 */
	public static function export_products() {
		// Pass 1: every product the store has, of every type.
		//
		// No `type` filter on purpose. 1.0.x asked for
		// `array( 'simple', 'variable' )`, which silently dropped grouped,
		// external and every extension's own product type out of the
		// catalogue — and the app then treated those rows as a type it did
		// not recognise. This query returns every `product` post, whatever
		// `product_type` term it carries.
		$parents    = array();
		$variations = array();
		$page       = 1;
		do {
			$products = wc_get_products(
				array(
					'limit'  => 100,
					'page'   => $page,
					'status' => 'publish',
					'return' => 'objects',
				)
			);
			foreach ( $products as $product ) {
				// A variation is a `product_variation` post, so it is not in
				// this query — but a plugin that registers its own variation-
				// like type can be, so filter by the type, not by assumption.
				if ( 'variation' === $product->get_type() ) {
					$variations[] = $product;
				} else {
					$parents[] = $product;
				}
			}
			++$page;
		} while ( count( $products ) === 100 );

		// Pass 2: variations — the sellable children under variable products,
		// each with its own SKU, price and stock.
		$page = 1;
		do {
			$children = wc_get_products(
				array(
					'limit'  => 100,
					'page'   => $page,
					'status' => 'publish',
					'type'   => 'variation',
					'return' => 'objects',
				)
			);
			foreach ( $children as $variation ) {
				$variations[] = $variation;
			}
			++$page;
		} while ( count( $children ) === 100 );

		// Parents first, then children: the app cannot create a variation
		// before the row it hangs off exists, and the queue delivers in the
		// order rows were written.
		foreach ( $parents as $product ) {
			POS_Connector_Queue::enqueue( 'product.updated', $product->get_id(), self::product_payload( $product ) );
		}
		foreach ( $variations as $product ) {
			POS_Connector_Queue::enqueue( 'product.updated', $product->get_id(), self::product_payload( $product ) );
		}

		POS_Connector_Log::info(
			'export',
			sprintf( '%d محصول و %d تنوع در صف ارسال قرار گرفت.', count( $parents ), count( $variations ) )
		);
	}

	/**
	 * Re-send every order changed in the last `$days` days.
	 *
	 * `wc_get_orders` with `date_modified` is the whole point: it finds the
	 * orders that changed *since the last sweep*, including the ones whose
	 * hooks never fired. Bounded by ORDER_SWEEP_LIMIT so a store with a busy
	 * week cannot fill a night with one run.
	 */
	public static function export_orders( $days = 7 ) {
		$days = max( 1, min( 365, (int) $days ) );
		$after = gmdate( 'Y-m-d H:i:s', time() - ( $days * DAY_IN_SECONDS ) );

		$orders = wc_get_orders(
			array(
				'limit'         => self::ORDER_SWEEP_LIMIT,
				'date_modified' => '>' . $after,
				'orderby'       => 'date',
				'order'         => 'ASC',
				// Refunds and subscriptions are not orders; drafts and trashed
				// rows are not sales.
				'status'        => array_keys( wc_get_order_statuses() ),
				'return'        => 'objects',
			)
		);

		foreach ( $orders as $order ) {
			POS_Connector_Queue::enqueue( 'order.updated', $order->get_id(), self::order_payload( $order ) );
		}

		POS_Connector_Log::info(
			'export',
			sprintf( '%d سفارشِ %d روز گذشته در صف ارسال قرار گرفت.', count( $orders ), $days )
		);
		return count( $orders );
	}

	public static function export_customers() {
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
