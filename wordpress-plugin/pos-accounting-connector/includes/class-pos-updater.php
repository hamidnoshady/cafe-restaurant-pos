<?php
/**
 * The self-update system — GitHub is the update server.
 *
 * This plugin is not in the WordPress.org directory, so core will never
 * learn a new version exists: the directory's API is the only update source
 * WordPress ships with. What this class adds is the standard trio of hooks
 * a third-party update needs, all pointed at the one canonical home of the
 * code — this repository's GitHub releases:
 *
 *   pre_set_site_transient_update_plugins   put a newer release into
 *                                           «افزونه‌ها ← به‌روزرسانی‌های موجود»
 *   plugins_api                             the «مشاهدهٔ جزئیات نسخهٔ …» modal
 *   upgrader_source_selection               make a GitHub zip installable
 *
 * A published release is preferred because it carries the notes the details
 * modal shows and (per the release runbook in
 * docs/wordpress-plugin-updates.md) a `pos-accounting-connector.zip` asset
 * that extracts to the right folder and needs no help installing. A bare tag
 * works too — its zipball is the *whole repository*, with the plugin buried
 * at `wordpress-plugin/pos-accounting-connector/`, which is why the third
 * hook exists: it re-points the source at that subfolder before WordPress
 * copies it over the installed plugin. Both paths must work, because
 * «tagging a release» must be enough to ship one.
 *
 * Checks are cached in an option (six hours for a good answer, fifteen
 * minutes for a failure) and ride the cycle WordPress already runs —
 * `wp_update_plugins()` twice daily from WP-Cron and on demand from the
 * Updates screen's «بررسی دوباره» — so a store costs GitHub two
 * unauthenticated API calls a day, nowhere near the 60-per-hour-per-IP
 * limit, and no ordinary page view ever waits on GitHub. The settings
 * screen and `wp pos-connector status` print the cached answer only; the
 * «بررسی به‌روزرسانی» button and `wp pos-connector check-update` are the two
 * things that force a call.
 *
 * The `package` URL is rebuilt here and host-checked before it is handed to
 * WordPress, because that is the URL WordPress will download and run:
 * constrained to this repository's tags and assets on GitHub's own download
 * hosts, never just whatever the API response said.
 */

defined( 'ABSPATH' ) || exit;

class POS_Connector_Updater {

	/** The cached check. An option, not a transient, so uninstall can remove it by name and the screen can show when it ran. */
	const CACHE_OPTION = 'pos_connector_update';

	/** How long a successful check stays fresh. Two a day matches the cycle WordPress already runs. */
	const CHECK_TTL = 6 * HOUR_IN_SECONDS;

	/** A failed check is retried sooner — GitHub being unreachable for a moment must not cost six hours of silence. */
	const CHECK_FAILURE_TTL = 15 * MINUTE_IN_SECONDS;

	/** The zip asset the release runbook attaches; extracting to the right folder, it needs no fix_source_dir() help. */
	const ASSET_NAME = 'pos-accounting-connector.zip';

	public static function init() {
		add_filter( 'pre_set_site_transient_update_plugins', array( __CLASS__, 'inject_update' ) );
		add_filter( 'plugins_api', array( __CLASS__, 'plugin_details' ), 10, 3 );
		add_filter( 'upgrader_source_selection', array( __CLASS__, 'fix_source_dir' ), 10, 4 );
		add_action( 'upgrader_process_complete', array( __CLASS__, 'after_update' ), 10, 2 );
		add_action( 'admin_post_pos_connector_check_update', array( __CLASS__, 'handle_check_update' ) );
	}

	/** `pos-accounting-connector/pos-accounting-connector.php` — the key WordPress indexes plugin updates by. */
	private static function plugin_basename() {
		return plugin_basename( POS_CONNECTOR_FILE );
	}

	/**
	 * The `owner/repo` to ask about. A constant everywhere except through this
	 * filter, which is how a private fork (needing its own token headers, see
	 * below) points the updater at itself without forking the class.
	 */
	private static function repo() {
		$repo = apply_filters( 'pos_connector_update_repo', POS_CONNECTOR_UPDATE_REPO );
		return is_string( $repo ) && preg_match( '/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/', $repo ) ? $repo : POS_CONNECTOR_UPDATE_REPO;
	}

	/**
	 * The newest known version, from the cache when fresh.
	 *
	 * `inject_update()` is the only caller that may reach the network — it
	 * runs inside WordPress's own update cycle (cron or the Updates screen),
	 * where a blocking call is what every third-party updater makes. The
	 * settings screen uses `cached()`, which never does.
	 */
	public static function latest( $force = false ) {
		$cached = self::read_cache();
		$ttl    = empty( $cached['ok'] ) ? self::CHECK_FAILURE_TTL : self::CHECK_TTL;
		if ( ! $force && ! empty( $cached['checked_at'] ) && ( time() - (int) $cached['checked_at'] ) < $ttl ) {
			return $cached;
		}
		return self::check();
	}

	/** The cached answer, whatever it is. Never touches the network: a page render must not wait on GitHub. */
	public static function cached() {
		return self::read_cache();
	}

	private static function read_cache() {
		$defaults = array(
			// The last *successful* answers. Kept verbatim on a failed
			// refresh (see check()): a transient GitHub outage must not
			// erase the version an update nag was already built from.
			'version'      => '',
			'download_url' => '',
			'url'          => '',
			'changelog'    => '',
			'published_at' => '',
			'checked_at'   => 0,
			'ok'           => false,
			'error'        => '',
		);
		$stored = get_option( self::CACHE_OPTION, array() );
		return wp_parse_args( is_array( $stored ) ? $stored : array(), $defaults );
	}

	/**
	 * Ask GitHub what the newest release is, and cache the answer.
	 */
	public static function check() {
		$cached = self::read_cache();

		$version = '';
		$package = '';
		$url     = '';
		$notes   = '';
		$when    = '';
		$error   = '';

		$release = self::api( '/repos/' . self::repo() . '/releases/latest' );

		if ( is_wp_error( $release ) && 'http_404' === $release->get_error_code() ) {
			// No published release at all — not an error, just the fallback
			// path: a plain tag is still a shippable version.
			$tags = self::api( '/repos/' . self::repo() . '/tags?per_page=1' );
			if ( is_wp_error( $tags ) ) {
				$error = $tags->get_error_message();
			} elseif ( empty( $tags[0]['name'] ) ) {
				$error = 'no_release_found';
			} else {
				$tag     = (string) $tags[0]['name'];
				$version = self::normalize_version( $tag );
				$error   = '' === $version ? 'unreadable_tag' : '';
				if ( '' !== $version ) {
					$package = self::zipball_url( $tag );
					$url     = 'https://github.com/' . self::repo() . '/releases/tag/' . rawurlencode( $tag );
				}
			}
		} elseif ( is_wp_error( $release ) ) {
			$error = $release->get_error_message();
		} else {
			$tag     = isset( $release['tag_name'] ) ? (string) $release['tag_name'] : '';
			$version = self::normalize_version( $tag );
			if ( '' === $version ) {
				$error = 'unreadable_tag';
			} else {
				$package = self::release_package( $release, $tag );
				$url     = isset( $release['html_url'] ) ? (string) $release['html_url'] : '';
				$notes   = isset( $release['body'] ) ? (string) $release['body'] : '';
				$when    = isset( $release['published_at'] ) ? (string) $release['published_at'] : '';
			}
		}

		// The one URL check that can kill an update: this is what WordPress
		// will download and run, so it is constrained before it becomes a
		// `package`, not trusted because the API said so.
		if ( '' !== $package && ! self::valid_package_url( $package ) ) {
			$error   = 'unexpected_package_url';
			$package = '';
		}
		if ( '' === $version && '' === $error ) {
			$error = 'no_release_found';
		}

		if ( '' !== $error ) {
			// Keep yesterday's good answer on the shelf, mark the check as
			// failed so it is retried on the short TTL, and leave a line in
			// «گزارش رویدادها» — «به‌روز نیست و نمی‌گویم چرا» is the diagnosable
			// state this avoids.
			POS_Connector_Log::error( 'update', $error );
		} else {
			$url = '' !== $url ? $url : 'https://github.com/' . self::repo();
			$cached = array(
				'version'      => $version,
				'download_url' => $package,
				'url'          => $url,
				'changelog'    => $notes,
				'published_at' => $when,
				'checked_at'   => time(),
				'ok'           => true,
				'error'        => '',
			);
			update_option( self::CACHE_OPTION, $cached, false );
			return $cached;
		}

		$cached['checked_at'] = time();
		$cached['ok']         = false;
		$cached['error']      = $error;
		update_option( self::CACHE_OPTION, $cached, false );
		return $cached;
	}

	/**
	 * One GitHub API GET. Unauthenticated — this repository is public and the
	 * check is cached, so a store makes two calls a day. The
	 * `pos_connector_updater_headers` filter is where a private fork adds its
	 * token headers without touching this class.
	 */
	private static function api( $path ) {
		$response = wp_remote_get(
			'https://api.github.com' . $path,
			array(
				'timeout' => 10,
				'headers' => apply_filters(
					'pos_connector_updater_headers',
					array(
						'Accept'     => 'application/vnd.github+json',
						// GitHub rejects requests without one; also tells
						// GitHub which version is asking.
						'User-Agent' => 'pos-accounting-connector/' . POS_CONNECTOR_VERSION,
					),
					$path
				),
			)
		);

		if ( is_wp_error( $response ) ) {
			return new WP_Error( 'request_failed', $response->get_error_message() );
		}

		$status = (int) wp_remote_retrieve_response_code( $response );
		$body   = json_decode( wp_remote_retrieve_body( $response ), true );

		if ( 404 === $status ) {
			return new WP_Error( 'http_404', 'not_found' );
		}
		if ( $status < 200 || $status >= 300 || ! is_array( $body ) ) {
			return new WP_Error( 'http_' . $status, 'http_' . $status );
		}
		return $body;
	}

	/**
	 * `v1.4.0` → `1.4.0`. Anything that is not a plain version is refused,
	 * because this string becomes the `new_version` WordPress compares and
	 * the one a user reads before clicking update.
	 */
	private static function normalize_version( $tag ) {
		$tag = ltrim( trim( (string) $tag ), 'vV' );
		return preg_match( '/^\d+(\.\d+){0,3}(-[A-Za-z0-9.-]+)?$/', $tag ) ? $tag : '';
	}

	/**
	 * Pick the zip this update installs from: a release asset when one was
	 * attached (the runbook's output — small, right folder name), otherwise
	 * the zipball of the tag (the whole repository, which fix_source_dir()
	 * digs the plugin out of).
	 */
	private static function release_package( array $release, $tag ) {
		if ( ! empty( $release['assets'] ) && is_array( $release['assets'] ) ) {
			$any_zip = '';
			foreach ( $release['assets'] as $asset ) {
				if ( empty( $asset['name'] ) || empty( $asset['browser_download_url'] ) ) {
					continue;
				}
				if ( self::ASSET_NAME === $asset['name'] ) {
					return (string) $asset['browser_download_url'];
				}
				if ( '.zip' === strtolower( substr( (string) $asset['name'], -4 ) ) ) {
					$any_zip = (string) $asset['browser_download_url'];
				}
			}
			if ( '' !== $any_zip ) {
				return $any_zip;
			}
		}
		return self::zipball_url( $tag );
	}

	/** The whole-repository zip behind a tag — GitHub's own download host, no redirect hop. */
	private static function zipball_url( $tag ) {
		return 'https://codeload.github.com/' . self::repo() . '/zip/refs/tags/' . rawurlencode( $tag );
	}

	/**
	 * Constrain the `package` to this repository's own download hosts. The
	 * signed `objects.githubusercontent.com` paths release-asset redirects
	 * land on are opaque, so the host alone is trusted there; every other
	 * host must also carry the repository's own `owner/repo` in the path.
	 */
	private static function valid_package_url( $url ) {
		$host = wp_parse_url( (string) $url, PHP_URL_HOST );
		$path = (string) wp_parse_url( (string) $url, PHP_URL_PATH );

		if ( ! in_array( $host, array( 'github.com', 'codeload.github.com', 'objects.githubusercontent.com', 'api.github.com' ), true ) ) {
			return false;
		}
		if ( 'objects.githubusercontent.com' === $host ) {
			return '' !== $path;
		}
		return false !== strpos( '/' . $path . '/', '/' . self::repo() . '/' );
	}

	/** The one comparison every path shares: is the remote version newer than the installed one? */
	public static function is_newer( $version ) {
		return (bool) version_compare( (string) $version, POS_CONNECTOR_VERSION, '>' );
	}

	/**
	 * Put a newer GitHub release into WordPress's update list.
	 *
	 * Runs inside `wp_update_plugins()` — twice daily from WP-Cron, and on
	 * demand from the Updates screen's «بررسی دوباره» — which is exactly the
	 * cadence an update check should have. The first GitHub call of a store's
	 * life happens inside this cycle, never on an ordinary page view.
	 */
	public static function inject_update( $transient ) {
		if ( ! is_object( $transient ) ) {
			return $transient;
		}

		$latest = self::latest();

		// Not `ok` — the last *successful* answer is kept verbatim by
		// check() through a failed refresh, and an update nag that was
		// already showing should survive GitHub being down for a quarter
		// hour. Only a missing version, a missing (or rejected) package URL
		// or «not actually newer» turns into «checked, up to date».
		if ( empty( $latest['version'] ) || empty( $latest['download_url'] ) || ! self::is_newer( $latest['version'] ) ) {
			// «بررسی شد، به‌روز است» — recorded so the Plugins screen counts
			// this plugin as *checked* rather than unknown, the same way a
			// wordpress.org plugin is.
			$transient->no_update[ self::plugin_basename() ] = (object) array(
				'slug'        => 'pos-accounting-connector',
				'plugin'      => self::plugin_basename(),
				'new_version' => POS_CONNECTOR_VERSION,
				'url'         => 'https://github.com/' . self::repo(),
				'package'     => '',
			);
			return $transient;
		}

		$transient->response[ self::plugin_basename() ] = (object) array(
			'slug'          => 'pos-accounting-connector',
			'plugin'        => self::plugin_basename(),
			'new_version'   => $latest['version'],
			'url'           => $latest['url'],
			'package'       => $latest['download_url'],
			'requires'      => self::header( 'Requires at least' ),
			'requires_php'  => self::header( 'Requires PHP' ),
		);
		return $transient;
	}

	/**
	 * The «مشاهدهٔ جزئیات نسخهٔ …» modal. Without this the link would ask the
	 * WordPress.org API, which knows nothing about this plugin.
	 */
	public static function plugin_details( $result, $action, $args ) {
		if ( 'plugin_information' !== $action || empty( $args->slug ) || 'pos-accounting-connector' !== $args->slug ) {
			return $result;
		}

		$latest = self::latest();

		$sections = array(
			'description' => __( 'اتصال امن و دوطرفهٔ فروشگاه ووکامرس به سامانهٔ فروش و حسابداری: ارسال سفارش، برگشت وجه، محصول و مشتری؛ دریافت موجودی و قیمت.', 'pos-accounting-connector' ),
		);
		if ( '' !== $latest['changelog'] ) {
			// Release notes are GitHub-flavoured markdown; this is the
			// closest thing to rendering them inside a WordPress modal, and
			// wp_kses_post keeps them from carrying anything a note should not.
			$sections['changelog'] = wp_kses_post( wpautop( $latest['changelog'] ) );
		} else {
			$sections['changelog'] = '<p>' . esc_html__( 'یادداشت انتشار این نسخه در گیت‌هاب نوشته شده است.', 'pos-accounting-connector' ) . '</p>';
		}

		return (object) array(
			'name'          => 'POS Accounting Connector',
			'slug'          => 'pos-accounting-connector',
			'version'       => '' !== $latest['version'] ? $latest['version'] : POS_CONNECTOR_VERSION,
			'download_link' => $latest['download_url'],
			'author'        => '<a href="https://github.com/hamidnoshady">hamidnoshady</a>',
			'homepage'      => 'https://github.com/hamidnoshady/cafe-restaurant-pos',
			'requires'      => self::header( 'Requires at least' ),
			'requires_php'  => self::header( 'Requires PHP' ),
			'tested'        => '6.7',
			'sections'      => $sections,
			'last_updated'  => '' !== $latest['published_at'] ? gmdate( 'Y-m-d', strtotime( $latest['published_at'] ) ) : '',
		);
	}

	/** One header from the plugin file — the same values the update row advertises. */
	private static function header( $key ) {
		static $headers = null;
		if ( null === $headers ) {
			$headers = get_file_data(
				POS_CONNECTOR_FILE,
				array(
					'Requires at least' => 'Requires at least',
					'Requires PHP'      => 'Requires PHP',
				)
			);
		}
		return isset( $headers[ $key ] ) ? (string) $headers[ $key ] : '';
	}

	/**
	 * Make a GitHub zip installable — the third hook, and the one that makes
	 * the no-asset path work.
	 *
	 * A release asset built by package-release.sh extracts to
	 * `pos-accounting-connector/…` and needs nothing. The repository zipball
	 * extracts to the whole monorepo — Next.js app, docs, docker and all —
	 * with the plugin at `wordpress-plugin/pos-accounting-connector/`, so the
	 * source WordPress copies from has to be re-pointed at that subfolder;
	 * the rest of the tree is deleted by the upgrader's own working-directory
	 * cleanup afterwards.
	 *
	 * Only ever claims its own install: `hook_extra` carries the plugin
	 * basename on updates (core since 5.5), and an upload-install without
	 * one — «افزونه‌ها ← افزودن ← بارگذاری» — is claimed only if the zip
	 * actually looks like this plugin.
	 *
	 * Everything goes through `$wp_filesystem`, never `file_exists()` /
	 * `rename()`: on an ftpext/ssh2 host the extracted files are not on the
	 * web server's own disk, and the paths here are filesystem-API paths.
	 */
	public static function fix_source_dir( $source, $remote_source, $upgrader, $hook_extra = array() ) {
		global $wp_filesystem;
		if ( ! is_string( $source ) || '' === $source || ! $wp_filesystem ) {
			return $source;
		}
		$fs = $wp_filesystem;

		if ( ! empty( $hook_extra['plugin'] ) ) {
			// Somebody else's update — never touch it.
			if ( self::plugin_basename() !== $hook_extra['plugin'] ) {
				return $source;
			}
		} elseif ( ! self::source_looks_like_this_plugin( $source, $fs ) ) {
			// An upload-install with no plugin name in hook_extra: claim it
			// only if the zip looks like us.
			return $source;
		}

		$source = untrailingslashit( $source );

		// The zipball case: the plugin is buried one level deep.
		$nested = $source . '/wordpress-plugin/pos-accounting-connector';
		if ( $fs->exists( $nested . '/pos-accounting-connector.php' ) ) {
			return $nested;
		}

		// The plugin sits at the root of the zip, whatever the folder is called.
		if ( $fs->exists( $source . '/pos-accounting-connector.php' ) ) {
			// An update installs over the existing
			// wp-content/plugins/pos-accounting-connector whatever the source
			// folder is called, so renaming buys nothing there and would only
			// orphan a copy of the tree in wp-content/upgrade/. A fresh
			// install, though, *does* copy the source folder's name — and
			// `pos-accounting-connector` is the folder name the rest of this
			// codebase (and `wp plugin update pos-accounting-connector`)
			// expects to stay true.
			if ( empty( $hook_extra['plugin'] ) && 'pos-accounting-connector' !== basename( $source ) ) {
				$target = dirname( $source ) . '/pos-accounting-connector';
				if ( ! $fs->exists( $target ) && $fs->move( $source, $target ) ) {
					return $target;
				}
			}
			return $source;
		}

		return $source;
	}

	/** Does this extracted zip contain this plugin, at either known layout? Used only for unnamed upload-installs. */
	private static function source_looks_like_this_plugin( $source, $fs ) {
		$source = untrailingslashit( (string) $source );
		return $fs->exists( $source . '/pos-accounting-connector.php' )
			|| $fs->exists( $source . '/wordpress-plugin/pos-accounting-connector/pos-accounting-connector.php' );
	}

	/**
	 * After a successful update: forget the cached check (it describes the
	 * version that was just replaced) and write the one log line that lets
	 * an owner tell an update apart in «گزارش رویدادها».
	 */
	public static function after_update( $upgrader, $options ) {
		if ( 'update' !== $options['action'] || 'plugin' !== $options['type'] ) {
			return;
		}
		$updated = array();
		if ( ! empty( $options['plugin'] ) ) {
			$updated[] = $options['plugin'];
		}
		if ( ! empty( $options['plugins'] ) ) {
			$updated = array_merge( $updated, (array) $options['plugins'] );
		}
		if ( ! in_array( self::plugin_basename(), $updated, true ) ) {
			return;
		}

		// The new files are on disk but this process still holds the old
		// constant, so the *cached* version — the one just installed — is
		// what the log line should say, read before the cache is dropped.
		$was = self::read_cache();
		delete_option( self::CACHE_OPTION );
		POS_Connector_Log::info( 'update', sprintf( 'افزونه به نسخهٔ %s به‌روز شد.', '' !== $was['version'] ? $was['version'] : 'جدید' ) );
	}

	/**
	 * «بررسی به‌روزرسانی» — the one user-initiated GitHub call, following the
	 * screen's own admin-post pattern.
	 */
	public static function handle_check_update() {
		if ( ! current_user_can( 'manage_woocommerce' ) ) {
			wp_die( esc_html__( 'دسترسی مجاز نیست.', 'pos-accounting-connector' ) );
		}
		check_admin_referer( 'pos_connector_check_update' );

		$latest = self::check();

		$notice = 'update_check_failed';
		if ( empty( $latest['error'] ) && self::is_newer( $latest['version'] ) ) {
			$notice = 'update_available';
		} elseif ( empty( $latest['error'] ) ) {
			$notice = 'up_to_date';
		}

		wp_safe_redirect(
			add_query_arg(
				array(
					'page'       => POS_Connector_Settings::PAGE_SLUG,
					'pos_notice' => rawurlencode( $notice ),
				),
				admin_url( 'admin.php' )
			)
		);
		exit;
	}
}
