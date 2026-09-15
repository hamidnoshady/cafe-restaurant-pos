<?php
/**
 * The admin screen: connect, test, watch, manage.
 *
 * Two fields to fill in — address and token — because that is the whole
 * configuration. Everything else about the connection (which entities sync,
 * the store's currency unit) is owned by the accounting dashboard and arrives
 * on each handshake, so there is exactly one place to change any given
 * setting.
 *
 * «آزمایش اتصال» is the first thing on the page for the same reason it exists
 * at all: an address typo, a truncated token and a wrong server clock all
 * present identically as "it isn't working", and the test is what tells them
 * apart before anyone starts guessing.
 */

defined( 'ABSPATH' ) || exit;

class POS_Connector_Settings {

	const PAGE_SLUG = 'pos-connector';

	public static function init() {
		add_action( 'admin_menu', array( __CLASS__, 'register_page' ) );
		add_action( 'admin_post_pos_connector_save', array( __CLASS__, 'handle_save' ) );
		add_action( 'admin_post_pos_connector_test', array( __CLASS__, 'handle_test' ) );
		add_action( 'admin_post_pos_connector_sync_now', array( __CLASS__, 'handle_sync_now' ) );
		add_action( 'admin_post_pos_connector_retry', array( __CLASS__, 'handle_retry' ) );
		// 1.1.0 — the two scheduled sweeps, runnable by hand. A cron that has
		// never fired is indistinguishable from one that is misconfigured
		// until somebody presses the button and watches what happens.
		add_action( 'admin_post_pos_connector_resync_products', array( __CLASS__, 'handle_resync_products' ) );
		add_action( 'admin_post_pos_connector_resync_orders', array( __CLASS__, 'handle_resync_orders' ) );
		add_action( 'admin_post_pos_connector_resync_customers', array( __CLASS__, 'handle_resync_customers' ) );
		add_action( 'admin_post_pos_connector_resync_content', array( __CLASS__, 'handle_resync_content' ) );
		add_action( 'admin_post_pos_connector_schedule', array( __CLASS__, 'handle_schedule' ) );
	}

	public static function register_page() {
		add_submenu_page(
			'woocommerce',
			__( 'اتصال حسابداری', 'pos-accounting-connector' ),
			__( 'اتصال حسابداری', 'pos-accounting-connector' ),
			'manage_woocommerce',
			self::PAGE_SLUG,
			array( __CLASS__, 'render' )
		);
	}

	private static function guard( $action ) {
		if ( ! current_user_can( 'manage_woocommerce' ) ) {
			wp_die( esc_html__( 'دسترسی مجاز نیست.', 'pos-accounting-connector' ) );
		}
		check_admin_referer( $action );
	}

	private static function redirect_back( $notice ) {
		wp_safe_redirect(
			add_query_arg(
				array(
					'page'       => self::PAGE_SLUG,
					'pos_notice' => rawurlencode( $notice ),
				),
				admin_url( 'admin.php' )
			)
		);
		exit;
	}

	public static function handle_save() {
		self::guard( 'pos_connector_save' );

		$base_url = isset( $_POST['base_url'] ) ? esc_url_raw( wp_unslash( $_POST['base_url'] ) ) : '';
		$token    = isset( $_POST['token'] ) ? sanitize_text_field( wp_unslash( $_POST['token'] ) ) : '';
		$enabled  = ! empty( $_POST['enabled'] );

		$changes = array(
			'base_url' => untrailingslashit( $base_url ),
			'enabled'  => $enabled,
		);
		// A blank token field means "leave the stored one alone" — the field is
		// rendered empty (never pre-filled with the secret), so treating blank
		// as "erase" would wipe the credential every time someone toggled a
		// checkbox and pressed save.
		if ( '' !== $token ) {
			$changes['token'] = $token;
		}

		pos_connector_update_settings( $changes );
		POS_Connector_Log::info( 'settings', 'تنظیمات ذخیره شد.' );
		self::redirect_back( 'saved' );
	}

	public static function handle_test() {
		self::guard( 'pos_connector_test' );

		$client = POS_Connector_Client::from_settings();
		if ( ! $client ) {
			self::redirect_back( 'test_not_configured' );
		}

		$response = $client->post( '/api/integrations/wordpress/ping' );
		if ( $response['ok'] ) {
			pos_connector_update_settings(
				array(
					'last_ok_at' => current_time( 'mysql', true ),
					'last_error' => '',
				)
			);
			POS_Connector_Log::info( 'test', 'اتصال برقرار است.' );
			self::redirect_back( 'test_ok' );
		}

		$message = POS_Connector_Client::explain( $response['error'] );
		pos_connector_update_settings( array( 'last_error' => $message ) );
		POS_Connector_Log::error( 'test', $message );
		self::redirect_back( 'test_failed' );
	}

	public static function handle_sync_now() {
		self::guard( 'pos_connector_sync_now' );
		POS_Connector_Sync::run();
		self::redirect_back( 'synced' );
	}

	public static function handle_retry() {
		self::guard( 'pos_connector_retry' );
		$count = POS_Connector_Queue::retry_failed();
		POS_Connector_Log::info( 'retry', sprintf( '%d رویداد دوباره در صف قرار گرفت.', $count ) );
		self::redirect_back( 'retried' );
	}

	public static function handle_resync_products() {
		self::guard( 'pos_connector_resync_products' );
		self::queue_products_export();
		self::redirect_back( 'products_queued' );
	}

	public static function handle_resync_orders() {
		self::guard( 'pos_connector_resync_orders' );
		$settings = pos_connector_settings();
		POS_Connector_Sync::export_orders( (int) $settings['resync_orders_days'] );
		POS_Connector_Log::info( 'export', 'بازخوانی دستی سفارش‌ها در صف قرار گرفت.' );
		self::redirect_back( 'orders_queued' );
	}

	public static function handle_resync_customers() {
		self::guard( 'pos_connector_resync_customers' );
		POS_Connector_Sync::export_customers();
		POS_Connector_Log::info( 'export', 'بازخوانی دستی مشتریان در صف قرار گرفت.' );
		self::redirect_back( 'customers_queued' );
	}

	public static function handle_resync_content() {
		self::guard( 'pos_connector_resync_content' );
		POS_Connector_Sync::export_content();
		POS_Connector_Log::info( 'export', 'بازخوانی دستی محتوا در صف قرار گرفت.' );
		self::redirect_back( 'content_queued' );
	}

	/**
	 * Save the sweep cadences and re-arm WP-Cron to match.
	 *
	 * The re-arm is the part that matters: `wp_schedule_event()` ignores a
	 * changed interval for a hook that is already scheduled, so without the
	 * clear-then-schedule in `pos_connector_schedule_event()` the screen would
	 * show «هر ساعت» while WP-Cron went on firing daily.
	 */
	public static function handle_schedule() {
		self::guard( 'pos_connector_schedule' );

		$products = isset( $_POST['resync_products_schedule'] )
			? sanitize_key( wp_unslash( $_POST['resync_products_schedule'] ) )
			: '';
		$orders = isset( $_POST['resync_orders_schedule'] )
			? sanitize_key( wp_unslash( $_POST['resync_orders_schedule'] ) )
			: '';
		$days = isset( $_POST['resync_orders_days'] ) ? (int) $_POST['resync_orders_days'] : 7;
		$days = max( 1, min( 365, $days ) );

		if ( ! array_key_exists( $products, pos_connector_resync_schedules() ) ) {
			$products = '';
		}
		if ( ! array_key_exists( $orders, pos_connector_order_resync_schedules() ) ) {
			$orders = '';
		}

		pos_connector_update_settings(
			array(
				'resync_products_schedule' => $products,
				'resync_orders_schedule'   => $orders,
				'resync_orders_days'       => $days,
			)
		);
		pos_connector_schedule_event( POS_CONNECTOR_CRON_RESYNC_PRODUCTS, $products );
		pos_connector_schedule_event( POS_CONNECTOR_CRON_RESYNC_ORDERS, $orders );

		POS_Connector_Log::info( 'schedule', 'زمان‌بندی به‌روز شد.' );
		self::redirect_back( 'schedule_saved' );
	}

	/** Queue a catalogue export without waiting for the sweep's turn. */
	private static function queue_products_export() {
		POS_Connector_Sync::export_products();
		pos_connector_update_settings( array( 'last_products_sweep_at' => current_time( 'mysql', true ) ) );
		POS_Connector_Log::info( 'export', 'بازخوانی دستی محصولات در صف قرار گرفت.' );
	}

	private static function notice_text( $key ) {
		$map = array(
			'saved'              => array( 'success', 'تنظیمات ذخیره شد.' ),
			'test_ok'            => array( 'success', 'اتصال برقرار است.' ),
			'test_failed'        => array( 'error', 'آزمایش اتصال ناموفق بود. متن خطا در پایین صفحه آمده است.' ),
			'test_not_configured' => array( 'error', 'ابتدا آدرس سامانه و توکن را وارد و ذخیره کنید.' ),
			'synced'             => array( 'success', 'همگام‌سازی اجرا شد.' ),
			'retried'            => array( 'success', 'رویدادهای ناموفق دوباره در صف قرار گرفتند.' ),
			'products_queued'    => array( 'success', 'کل کاتالوگ (با تنوع‌ها) در صف ارسال قرار گرفت.' ),
			'orders_queued'      => array( 'success', 'سفارش‌های بازهٔ انتخابی در صف ارسال قرار گرفتند.' ),
			'customers_queued'   => array( 'success', 'همهٔ مشتریان در صف ارسال قرار گرفتند.' ),
			'content_queued'     => array( 'success', 'نوشته‌ها، برگه‌ها و رسانه‌ها در صف ارسال قرار گرفتند.' ),
			'schedule_saved'     => array( 'success', 'زمان‌بندی ذخیره شد.' ),
			'update_available'   => array( 'warning', 'نسخهٔ جدید افزونه در گیت‌هاب منتشر شده است؛ از صفحهٔ «افزونه‌ها ← به‌روزرسانی‌های موجود» یا «پیشخوان ← به‌روزرسانی‌ها» نصبش کنید.' ),
			'up_to_date'         => array( 'success', 'افزونه به‌روز است.' ),
			'update_check_failed' => array( 'error', 'بررسی به‌روزرسانی ناموفق بود؛ دلیلش در «گزارش رویدادها» آمده است.' ),
		);
		return isset( $map[ $key ] ) ? $map[ $key ] : null;
	}

	public static function render() {
		$settings = pos_connector_settings();
		$counts   = POS_Connector_Queue::counts();
		$notice   = isset( $_GET['pos_notice'] ) ? self::notice_text( sanitize_key( wp_unslash( $_GET['pos_notice'] ) ) ) : null;
		?>
		<div class="wrap">
			<h1><?php esc_html_e( 'اتصال به سامانهٔ حسابداری', 'pos-accounting-connector' ); ?></h1>

			<?php if ( $notice ) : ?>
				<div class="notice notice-<?php echo esc_attr( $notice[0] ); ?>"><p><?php echo esc_html( $notice[1] ); ?></p></div>
			<?php endif; ?>

			<?php if ( ! empty( $settings['last_error'] ) ) : ?>
				<div class="notice notice-error">
					<p><strong><?php esc_html_e( 'آخرین خطا:', 'pos-accounting-connector' ); ?></strong>
					<?php echo esc_html( $settings['last_error'] ); ?></p>
				</div>
			<?php endif; ?>

			<h2><?php esc_html_e( 'اتصال', 'pos-accounting-connector' ); ?></h2>
			<p class="description">
				<?php esc_html_e( 'این دو مقدار را از پنل حسابداری، بخش «اتصال‌ها ← فروشگاه ووکامرس» بردارید.', 'pos-accounting-connector' ); ?>
			</p>

			<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">
				<?php wp_nonce_field( 'pos_connector_save' ); ?>
				<input type="hidden" name="action" value="pos_connector_save" />
				<table class="form-table" role="presentation">
					<tr>
						<th scope="row"><label for="pos-base-url"><?php esc_html_e( 'آدرس سامانه', 'pos-accounting-connector' ); ?></label></th>
						<td>
							<input name="base_url" id="pos-base-url" type="url" dir="ltr" class="regular-text"
								value="<?php echo esc_attr( $settings['base_url'] ); ?>" placeholder="https://mybusiness.example.com" />
							<p class="description"><?php esc_html_e( 'همان آدرسی که با آن وارد پنل حسابداری می‌شوید.', 'pos-accounting-connector' ); ?></p>
						</td>
					</tr>
					<tr>
						<th scope="row"><label for="pos-token"><?php esc_html_e( 'توکن اتصال', 'pos-accounting-connector' ); ?></label></th>
						<td>
							<input name="token" id="pos-token" type="password" dir="ltr" class="regular-text"
								autocomplete="off" placeholder="<?php echo $settings['token'] ? esc_attr__( 'برای حفظ توکن فعلی خالی بگذارید', 'pos-accounting-connector' ) : 'wplink_…'; ?>" />
							<p class="description">
								<?php
								echo $settings['token']
									? esc_html__( 'توکنی ثبت شده است. برای تعویض، توکن جدید را وارد کنید.', 'pos-accounting-connector' )
									: esc_html__( 'توکن فقط یک بار در پنل حسابداری نمایش داده می‌شود.', 'pos-accounting-connector' );
								?>
							</p>
						</td>
					</tr>
					<tr>
						<th scope="row"><?php esc_html_e( 'وضعیت', 'pos-accounting-connector' ); ?></th>
						<td>
							<label>
								<input type="checkbox" name="enabled" value="1" <?php checked( ! empty( $settings['enabled'] ) ); ?> />
								<?php esc_html_e( 'همگام‌سازی فعال باشد', 'pos-accounting-connector' ); ?>
							</label>
						</td>
					</tr>
				</table>
				<?php submit_button( __( 'ذخیره', 'pos-accounting-connector' ) ); ?>
			</form>

			<h2><?php esc_html_e( 'مدیریت اتصال', 'pos-accounting-connector' ); ?></h2>
			<p>
				<?php
				// Every handler registered in init() gets a button here. The
				// catalogue and order sweeps existed everywhere but the screen
				// from 1.1.0 on — handler, nonce check and success notice all
				// written, and no markup that ever posted to them — so the
				// manual «همگام‌سازی محصولات» the export doc-comment describes
				// was reachable only from WP-CLI.
				foreach ( array(
					'pos_connector_test'             => __( 'آزمایش اتصال', 'pos-accounting-connector' ),
					'pos_connector_sync_now'         => __( 'همگام‌سازی همین حالا', 'pos-accounting-connector' ),
					'pos_connector_retry'            => __( 'تلاش دوباره برای ناموفق‌ها', 'pos-accounting-connector' ),
					'pos_connector_resync_products'  => __( 'بازخوانی کل کاتالوگ', 'pos-accounting-connector' ),
					'pos_connector_resync_orders'    => __( 'بازخوانی سفارش‌های اخیر', 'pos-accounting-connector' ),
					'pos_connector_resync_customers' => __( 'بازخوانی همهٔ مشتریان', 'pos-accounting-connector' ),
					'pos_connector_resync_content'   => __( 'بازخوانی محتوا و رسانه', 'pos-accounting-connector' ),
				) as $action => $label ) : ?>
					<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" style="display:inline-block;margin-inline-end:8px">
						<?php wp_nonce_field( $action ); ?>
						<input type="hidden" name="action" value="<?php echo esc_attr( $action ); ?>" />
						<button type="submit" class="button"><?php echo esc_html( $label ); ?></button>
					</form>
				<?php endforeach; ?>
			</p>

			<h2><?php esc_html_e( 'زمان‌بندی همگام‌سازی', 'pos-accounting-connector' ); ?></h2>

			<p class="description">

				<?php esc_html_e( 'سه کارِ متفاوت، با سه هزینه و سه تحمل متفاوت برای تأخیر — برای همین جداگانه زمان‌بندی می‌شوند.', 'pos-accounting-connector' ); ?>

			</p>

			<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>">

				<?php wp_nonce_field( 'pos_connector_schedule' ); ?>

				<input type="hidden" name="action" value="pos_connector_schedule" />

				<table class="form-table" role="presentation">

					<tr>

						<th scope="row"><label for="pos-orders-schedule"><?php esc_html_e( 'بازخوانی سفارش‌ها', 'pos-accounting-connector' ); ?></label></th>

						<td>

							<select name="resync_orders_schedule" id="pos-orders-schedule">

								<?php foreach ( pos_connector_order_resync_schedules() as $key => $label ) : ?>

									<option value="<?php echo esc_attr( $key ); ?>" <?php selected( $settings['resync_orders_schedule'], $key ); ?>>

										<?php echo esc_html( $label ); ?>

									</option>

								<?php endforeach; ?>

							</select>

							<p class="description">

								<?php esc_html_e( 'سفارش‌هایی که در این بازه تغییر کرده‌اند دوباره فرستاده می‌شوند؛ پشتیبانِ قلاب‌هایی است که اجرا نشده باشند.', 'pos-accounting-connector' ); ?>

							</p>

						</td>

					</tr>

					<tr>

						<th scope="row"><label for="pos-orders-days"><?php esc_html_e( 'بازهٔ بازخوانی سفارش‌ها', 'pos-accounting-connector' ); ?></label></th>

						<td>

							<input name="resync_orders_days" id="pos-orders-days" type="number" min="1" max="365" dir="ltr"

								value="<?php echo esc_attr( (int) $settings['resync_orders_days'] ); ?>" />

							<?php esc_html_e( 'روز', 'pos-accounting-connector' ); ?>

						</td>

					</tr>

					<tr>

						<th scope="row"><label for="pos-products-schedule"><?php esc_html_e( 'بازخوانی کاتالوگ', 'pos-accounting-connector' ); ?></label></th>

						<td>

							<select name="resync_products_schedule" id="pos-products-schedule">

								<?php foreach ( pos_connector_resync_schedules() as $key => $label ) : ?>

									<option value="<?php echo esc_attr( $key ); ?>" <?php selected( $settings['resync_products_schedule'], $key ); ?>>

										<?php echo esc_html( $label ); ?>

									</option>

								<?php endforeach; ?>

							</select>

							<p class="description">

								<?php esc_html_e( 'کل کاتالوگ، با همهٔ تنوع‌ها، دوباره فرستاده می‌شود. در فروشگاه‌های بزرگ آن را کمتر (یا خاموش) نگه دارید؛ محصول هنگام هر ذخیره هم جداگانه ارسال می‌شود.', 'pos-accounting-connector' ); ?>

							</p>

						</td>

					</tr>

				</table>

				<?php submit_button( __( 'ذخیرهٔ زمان‌بندی', 'pos-accounting-connector' ) ); ?>

			</form>


			<table class="widefat striped" style="max-width:720px">
				<tbody>
					<tr>
						<th><?php esc_html_e( 'آخرین ارتباط موفق', 'pos-accounting-connector' ); ?></th>
						<td><?php echo esc_html( $settings['last_ok_at'] ? $settings['last_ok_at'] : '—' ); ?></td>
					</tr>
						<?php
						$schedules = array(
							POS_CONNECTOR_CRON_HOOK             => __( 'همگام‌سازی سریع (ارسال و دریافت)', 'pos-accounting-connector' ),
							POS_CONNECTOR_CRON_RESYNC_ORDERS    => __( 'بازخوانی سفارش‌ها', 'pos-accounting-connector' ),
							POS_CONNECTOR_CRON_RESYNC_PRODUCTS  => __( 'بازخوانی کاتالوگ', 'pos-accounting-connector' ),
							// The two daily backfills. Listed for the same
							// reason the others are: «زمان‌بندی نشده» is the
							// answer to "why did the customer book stop
							// filling in?", and it cannot be read anywhere else.
							POS_CONNECTOR_CRON_RESYNC_CUSTOMERS => __( 'بازخوانی مشتریان (روزانه)', 'pos-accounting-connector' ),
							POS_CONNECTOR_CRON_RESYNC_CONTENT   => __( 'بازخوانی محتوا (روزانه)', 'pos-accounting-connector' ),
						);
						foreach ( $schedules as $hook => $label ) :
							$at = wp_next_scheduled( $hook );
							?>
							<tr>
								<th>
									<?php echo esc_html( $label ); ?><br />
									<span class="description"><?php esc_html_e( 'اجرای بعدی', 'pos-accounting-connector' ); ?></span>
								</th>
								<td>
									<?php if ( $at ) : ?>
										<?php echo esc_html( gmdate( 'Y-m-d H:i:s', $at ) . ' UTC' ); ?>
										<code dir="ltr"><?php echo esc_html( $hook ); ?></code>
									<?php else : ?>
										<?php esc_html_e( 'زمان‌بندی نشده (خاموش)', 'pos-accounting-connector' ); ?>
									<?php endif; ?>
								</td>
							</tr>
						<?php endforeach; ?>
						<tr>
							<th><?php esc_html_e( 'آخرین بازخوانی کاتالوگ', 'pos-accounting-connector' ); ?></th>
							<td><?php echo esc_html( $settings['last_products_sweep_at'] ? $settings['last_products_sweep_at'] : '—' ); ?></td>
						</tr>
						<tr>
							<th><?php esc_html_e( 'آخرین بازخوانی سفارش‌ها', 'pos-accounting-connector' ); ?></th>
							<td><?php echo esc_html( $settings['last_orders_sweep_at'] ? $settings['last_orders_sweep_at'] : '—' ); ?></td>
						</tr>
					<tr>
						<th><?php esc_html_e( 'صف ارسال', 'pos-accounting-connector' ); ?></th>
						<td>
							<?php
							printf(
								/* translators: 1: pending count, 2: sent count, 3: failed count, 4: deferred count */
								esc_html__( 'در انتظار: %1$d — ارسال‌شده: %2$d — ناموفق: %3$d — در انتظارِ بازگشت: %4$d', 'pos-accounting-connector' ),
								(int) $counts['pending'],
								(int) $counts['sent'],
								(int) $counts['failed'],
								(int) POS_Connector_Queue::deferred_count()
							);
							?>
						</td>
					</tr>
					<tr>
						<th><?php esc_html_e( 'موارد همگام‌شونده', 'pos-accounting-connector' ); ?></th>
						<td>
							<?php
							$flags = array(
								__( 'سفارش‌ها', 'pos-accounting-connector' )        => ! empty( $settings['sync_orders'] ),
								__( 'محصولات', 'pos-accounting-connector' )         => ! empty( $settings['sync_products'] ),
								__( 'مشتریان', 'pos-accounting-connector' )         => ! empty( $settings['sync_customers'] ),
								__( 'دریافت موجودی', 'pos-accounting-connector' )   => ! empty( $settings['apply_stock'] ),
								__( 'دریافت قیمت', 'pos-accounting-connector' )     => ! empty( $settings['apply_prices'] ),
							);
							$on = array_keys( array_filter( $flags ) );
							echo esc_html( $on ? implode( '، ', $on ) : __( 'هیچ‌کدام', 'pos-accounting-connector' ) );
							?>
							<p class="description">
								<?php esc_html_e( 'این گزینه‌ها در پنل حسابداری تنظیم می‌شوند و در هر همگام‌سازی به‌روز می‌شوند.', 'pos-accounting-connector' ); ?>
							</p>
						</td>
					</tr>
				</tbody>
			</table>

			<h2><?php esc_html_e( 'کرون واقعی', 'pos-accounting-connector' ); ?></h2>

			<table class="widefat striped" style="max-width:720px">

				<tbody>

					<tr>

						<th style="width:230px"><?php esc_html_e( 'اجرای هر پنج دقیقه', 'pos-accounting-connector' ); ?></th>

						<td><code dir="ltr">*/5 * * * * wp --path=<?php echo esc_html( ABSPATH ); ?> pos-connector sync &gt; /dev/null 2&gt;&amp;1</code></td>

					</tr>

					<tr>

						<th><?php esc_html_e( 'یا: تخلیهٔ صف وردپرس', 'pos-accounting-connector' ); ?></th>

						<td><code dir="ltr">*/5 * * * * wp --path=<?php echo esc_html( ABSPATH ); ?> cron event run --due-now &gt; /dev/null 2&gt;&amp;1</code></td>

					</tr>

					<tr>

						<th><?php esc_html_e( 'وضعیت فعلی WP-Cron', 'pos-accounting-connector' ); ?></th>

						<td>

							<?php if ( defined( 'DISABLE_WP_CRON' ) && DISABLE_WP_CRON ) : ?>

								<span style="color:#1e8e3e"><?php esc_html_e( 'غیرفعال است — یک کرون واقعی در حال اجراست.', 'pos-accounting-connector' ); ?></span>

							<?php else : ?>

								<span style="color:#9a6700"><?php esc_html_e( 'فعال است: فقط هنگام بازدید از سایت اجرا می‌شود.', 'pos-accounting-connector' ); ?></span>

							<?php endif; ?>

						</td>

					</tr>

				</tbody>

			</table>

			<p class="description">

				<?php esc_html_e( 'دستور wp pos-connector status وضعیت اتصال، صف و زمان اجرای هر سه رویداد را چاپ می‌کند.', 'pos-accounting-connector' ); ?>

			</p>


			<h2><?php esc_html_e( 'به‌روزرسانی افزونه', 'pos-accounting-connector' ); ?></h2>

			<p class="description">

				<?php esc_html_e( 'این افزونه در مخزن وردپرس نیست؛ نسخه‌های جدید را از گیت‌هاب همین پروژه بررسی و نصب می‌کند — همان‌جا که به‌روزرسانی بقیهٔ افزونه‌ها دیده می‌شود.', 'pos-accounting-connector' ); ?>

			</p>

			<?php $update = POS_Connector_Updater::cached(); ?>

			<table class="widefat striped" style="max-width:720px">

				<tbody>

					<tr>

						<th style="width:230px"><?php esc_html_e( 'نسخهٔ نصب‌شده', 'pos-accounting-connector' ); ?></th>

						<td><code dir="ltr"><?php echo esc_html( POS_CONNECTOR_VERSION ); ?></code></td>

					</tr>

					<tr>

						<th><?php esc_html_e( 'آخرین نسخهٔ منتشرشده', 'pos-accounting-connector' ); ?></th>

						<td>

							<?php if ( '' !== $update['version'] ) : ?>

								<code dir="ltr"><?php echo esc_html( $update['version'] ); ?></code>

								<?php if ( POS_Connector_Updater::is_newer( $update['version'] ) ) : ?>

									<strong> — <?php esc_html_e( 'به‌روزرسانی موجود است؛ از صفحهٔ «افزونه‌ها» نصبش کنید.', 'pos-accounting-connector' ); ?></strong>

								<?php else : ?>

									<?php esc_html_e( '— به‌روز هستید.', 'pos-accounting-connector' ); ?>

								<?php endif; ?>

							<?php else : ?>

								<?php esc_html_e( 'هنوز نسخه‌ای پیدا نشده است. یک بار «بررسی به‌روزرسانی» را بزنید.', 'pos-accounting-connector' ); ?>

							<?php endif; ?>

						</td>

					</tr>

					<tr>

						<th><?php esc_html_e( 'آخرین بررسی', 'pos-accounting-connector' ); ?></th>

						<td>

							<?php echo esc_html( $update['checked_at'] ? gmdate( 'Y-m-d H:i:s', (int) $update['checked_at'] ) . ' UTC' : '—' ); ?>

							<?php if ( ! empty( $update['error'] ) ) : ?>

								<br /><span style="color:#b32d2e"><?php echo esc_html( sprintf( __( 'آخرین بررسی ناموفق بود: %s', 'pos-accounting-connector' ), $update['error'] ) ); ?></span>

							<?php endif; ?>

						</td>

					</tr>

				</tbody>

			</table>

			<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" style="margin-top:8px">

				<?php wp_nonce_field( 'pos_connector_check_update' ); ?>

				<input type="hidden" name="action" value="pos_connector_check_update" />

				<?php submit_button( __( 'بررسی به‌روزرسانی', 'pos-accounting-connector' ), 'secondary' ); ?>

			</form>

			<p class="description">

				<?php esc_html_e( 'بررسی خودکار روی همان چرخهٔ به‌روزرسانی وردپرس سوار است (دو بار در روز). نصب نسخهٔ جدید همان به‌روزرسانی معمولی وردپرس است و به‌روزرسانی خودکار هم کار می‌کند.', 'pos-accounting-connector' ); ?>

			</p>


			<h2><?php esc_html_e( 'گزارش رویدادها', 'pos-accounting-connector' ); ?></h2>
			<table class="widefat striped">
				<thead>
					<tr>
						<th style="width:170px"><?php esc_html_e( 'زمان (UTC)', 'pos-accounting-connector' ); ?></th>
						<th style="width:120px"><?php esc_html_e( 'رویداد', 'pos-accounting-connector' ); ?></th>
						<th><?php esc_html_e( 'توضیح', 'pos-accounting-connector' ); ?></th>
					</tr>
				</thead>
				<tbody>
					<?php $entries = POS_Connector_Log::recent( 30 ); ?>
					<?php if ( empty( $entries ) ) : ?>
						<tr><td colspan="3"><?php esc_html_e( 'رویدادی ثبت نشده است.', 'pos-accounting-connector' ); ?></td></tr>
					<?php endif; ?>
					<?php foreach ( $entries as $entry ) : ?>
						<tr>
							<td><?php echo esc_html( $entry['created_at'] ); ?></td>
							<td>
								<?php if ( 'error' === $entry['level'] ) : ?>
									<span style="color:#b32d2e"><?php echo esc_html( $entry['action'] ); ?></span>
								<?php else : ?>
									<?php echo esc_html( $entry['action'] ); ?>
								<?php endif; ?>
							</td>
							<td><?php echo esc_html( $entry['message'] ); ?></td>
						</tr>
					<?php endforeach; ?>
				</tbody>
			</table>
		</div>
		<?php
	}
}
