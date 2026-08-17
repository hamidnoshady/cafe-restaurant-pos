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

	private static function notice_text( $key ) {
		$map = array(
			'saved'              => array( 'success', 'تنظیمات ذخیره شد.' ),
			'test_ok'            => array( 'success', 'اتصال برقرار است.' ),
			'test_failed'        => array( 'error', 'آزمایش اتصال ناموفق بود. متن خطا در پایین صفحه آمده است.' ),
			'test_not_configured' => array( 'error', 'ابتدا آدرس سامانه و توکن را وارد و ذخیره کنید.' ),
			'synced'             => array( 'success', 'همگام‌سازی اجرا شد.' ),
			'retried'            => array( 'success', 'رویدادهای ناموفق دوباره در صف قرار گرفتند.' ),
		);
		return isset( $map[ $key ] ) ? $map[ $key ] : null;
	}

	public static function render() {
		$settings = pos_connector_settings();
		$counts   = POS_Connector_Queue::counts();
		$notice   = isset( $_GET['pos_notice'] ) ? self::notice_text( sanitize_key( wp_unslash( $_GET['pos_notice'] ) ) ) : null;
		$next_run = wp_next_scheduled( POS_CONNECTOR_CRON_HOOK );
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
				<?php foreach ( array(
					'pos_connector_test'     => __( 'آزمایش اتصال', 'pos-accounting-connector' ),
					'pos_connector_sync_now' => __( 'همگام‌سازی همین حالا', 'pos-accounting-connector' ),
					'pos_connector_retry'    => __( 'تلاش دوباره برای ناموفق‌ها', 'pos-accounting-connector' ),
				) as $action => $label ) : ?>
					<form method="post" action="<?php echo esc_url( admin_url( 'admin-post.php' ) ); ?>" style="display:inline-block;margin-inline-end:8px">
						<?php wp_nonce_field( $action ); ?>
						<input type="hidden" name="action" value="<?php echo esc_attr( $action ); ?>" />
						<button type="submit" class="button"><?php echo esc_html( $label ); ?></button>
					</form>
				<?php endforeach; ?>
			</p>

			<table class="widefat striped" style="max-width:720px">
				<tbody>
					<tr>
						<th><?php esc_html_e( 'آخرین ارتباط موفق', 'pos-accounting-connector' ); ?></th>
						<td><?php echo esc_html( $settings['last_ok_at'] ? $settings['last_ok_at'] : '—' ); ?></td>
					</tr>
					<tr>
						<th><?php esc_html_e( 'اجرای بعدی خودکار', 'pos-accounting-connector' ); ?></th>
						<td>
							<?php
							echo $next_run
								? esc_html( gmdate( 'Y-m-d H:i:s', $next_run ) . ' UTC' )
								: esc_html__( 'زمان‌بندی نشده — افزونه را غیرفعال و دوباره فعال کنید.', 'pos-accounting-connector' );
							?>
						</td>
					</tr>
					<tr>
						<th><?php esc_html_e( 'صف ارسال', 'pos-accounting-connector' ); ?></th>
						<td>
							<?php
							printf(
								/* translators: 1: pending count, 2: sent count, 3: failed count */
								esc_html__( 'در انتظار: %1$d — ارسال‌شده: %2$d — ناموفق: %3$d', 'pos-accounting-connector' ),
								(int) $counts['pending'],
								(int) $counts['sent'],
								(int) $counts['failed']
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
