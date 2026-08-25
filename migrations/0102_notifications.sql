-- Phase 35 — notifications («اعلان‌ها»).
--
-- Everything the app already knew about — a till that came up 400,000 ﷼ short,
-- a backup that failed at 03:00, a coworker job waiting for approval since last
-- night — it knew *on a screen nobody was looking at*. The owner is at home,
-- the manager is at the other branch, and the only way either found out was by
-- opening the dashboard and noticing. This phase gives those facts a way to
-- reach a phone.
--
-- Delivery is the Web Push standard (RFC 8030/8291/8292), which is what makes
-- one implementation cover iOS, Android and Windows at once: Safari 16.4+
-- delivers push to a PWA the user added to the home screen, and Chrome/Edge
-- deliver it on Android, Windows, macOS and Linux to an installed PWA or an
-- ordinary tab. The app is already a PWA with a service worker (Phase 12), so
-- the only thing missing was the subscription and the sender.
--
-- Four rules the schema encodes:
--
--   * **A notification is queued, never sent inline.** `notification_events` is
--     an outbox drained by a tick, exactly like `ai_coworker_events`: a cashier
--     closing a shift must not wait on — or fail because of — an HTTP round
--     trip to a push service in another country.
--   * **Who hears what is a *rule*, not a hard-coded list.** A rule is per
--     user, per event, and optionally per branch, and a user with no rule for
--     an event falls back to the catalogue's default for their role (see
--     src/lib/notifications.ts). So notifications work the day the feature ships
--     and every deviation from that is something a person chose.
--   * **The in-app record and the push attempt are different things.**
--     `notification_recipients` is the bell — one row per person per event, with
--     `read_at`. `notification_deliveries` is one row per *device* per event and
--     records whether the push service accepted it. Quiet hours suppress the
--     second and never the first: "don't wake me" is not "don't tell me".
--   * **A dead subscription is deleted, not retried forever.** A push service
--     answering 404/410 is telling us the browser is gone (uninstalled, site
--     data cleared); `notification_devices.failure_count` carries the softer
--     failures, and the tick disables a device that keeps failing.

-- ---------------------------------------------------------------------------
-- The VAPID identity (platform-wide, so tenant-exempt — see tenant-tables.ts)
--
-- VAPID (RFC 8292) is how a push service knows which application server a
-- message came from, and the public half is baked into every subscription a
-- browser creates. Rotating it therefore invalidates every existing device, so
-- the pair is generated once, on first use, and then left alone. It lives in
-- the database rather than in env because an on-site install has no operator
-- to run a key-generation step, and a notification system that needs one would
-- simply be off on every such install.
-- ---------------------------------------------------------------------------
CREATE TABLE platform_push_config (
    id              boolean PRIMARY KEY DEFAULT true CHECK (id),
    -- Base64url, uncompressed P-256 point (65 bytes) / raw scalar (32 bytes).
    public_key      text NOT NULL,
    private_key     text NOT NULL,
    -- The `sub` claim of the VAPID JWT: a mailto: or https: URL a push service
    -- operator can use to reach whoever runs this deployment.
    subject         text NOT NULL DEFAULT 'mailto:admin@example.com',
    created_at      timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Devices
--
-- One row per browser push subscription. `endpoint` is globally unique — it is
-- the push service's own URL for this subscription — which makes re-subscribing
-- an UPSERT rather than a duplicate, and means the same physical phone used by
-- two people at two businesses is correctly two rows.
-- ---------------------------------------------------------------------------
CREATE TABLE notification_devices (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id     uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    endpoint        text NOT NULL UNIQUE,
    -- The subscription's own ECDH public key and auth secret (RFC 8291). Both
    -- base64url. Without them a payload cannot be encrypted, so a row missing
    -- either is unusable rather than merely degraded.
    p256dh          text NOT NULL,
    auth            text NOT NULL,
    -- What the browser said it is, so the settings list can say «آیفون» rather
    -- than showing a 200-character endpoint URL. Advisory only.
    platform        text NOT NULL DEFAULT 'other'
                        CHECK (platform IN ('ios', 'android', 'windows', 'macos', 'linux', 'other')),
    label           text NOT NULL DEFAULT '',
    user_agent      text NOT NULL DEFAULT '',
    created_at      timestamptz NOT NULL DEFAULT now(),
    last_seen_at    timestamptz NOT NULL DEFAULT now(),
    last_success_at timestamptz,
    -- Reset on every accepted push. A device that keeps failing is disabled
    -- rather than retried into the next decade.
    failure_count   smallint NOT NULL DEFAULT 0 CHECK (failure_count >= 0),
    last_error      text,
    disabled_at     timestamptz
);

CREATE INDEX idx_notification_devices_user ON notification_devices (business_id, user_id)
    WHERE disabled_at IS NULL;

-- ---------------------------------------------------------------------------
-- Rules
--
-- The owner's answer to "tell me about this, at this branch, on these channels,
-- but not in the middle of the night". A missing row is not "off": it means the
-- catalogue's per-role default applies (src/lib/notifications.ts), which is what
-- makes the feature useful before anybody has configured anything.
-- ---------------------------------------------------------------------------
CREATE TABLE notification_rules (
    id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id         uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    user_id             uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    event_key           text NOT NULL,
    -- NULL = every branch. A rule naming a branch only matches that branch's
    -- events, and beats an all-branch rule for the same event.
    location_id         uuid REFERENCES locations(id) ON DELETE CASCADE,
    enabled             boolean NOT NULL DEFAULT true,
    -- Which ways this person wants to be told. 'push' is the phone; 'inapp' is
    -- the bell inside the dashboard. Empty would mean "enabled but silent",
    -- which is a state nobody wants, so it is refused.
    channels            text[] NOT NULL DEFAULT ARRAY['push', 'inapp']::text[]
                            CHECK (cardinality(channels) > 0 AND channels <@ ARRAY['push', 'inapp']::text[]),
    -- The floor: an event less severe than this is dropped for this person.
    min_severity        text NOT NULL DEFAULT 'info'
                            CHECK (min_severity IN ('info', 'important', 'critical')),
    -- For the events that carry a money figure (a cash variance, a refund), the
    -- Rial amount below which this person does not want to hear about it. NULL
    -- = every amount. Stored in integer Rial like all money here.
    min_amount_rial     bigint CHECK (min_amount_rial IS NULL OR min_amount_rial >= 0),
    -- Minutes past local midnight. A window that wraps (22:00 → 07:00) is
    -- normal and handled in application code, so from > to is legal.
    quiet_from_minutes  smallint CHECK (quiet_from_minutes IS NULL OR quiet_from_minutes BETWEEN 0 AND 1439),
    quiet_to_minutes    smallint CHECK (quiet_to_minutes IS NULL OR quiet_to_minutes BETWEEN 0 AND 1439),
    created_at          timestamptz NOT NULL DEFAULT now(),
    updated_at          timestamptz NOT NULL DEFAULT now(),
    -- Quiet hours are a window or they are absent; one half alone is a
    -- half-configured rule whose behaviour nobody could predict.
    CONSTRAINT notification_rules_quiet_shape CHECK (
        (quiet_from_minutes IS NULL) = (quiet_to_minutes IS NULL)
    ),
    -- NULLS NOT DISTINCT (PG 15+) so the all-branch rule is genuinely one row
    -- per user per event, rather than something a double POST can duplicate.
    UNIQUE NULLS NOT DISTINCT (user_id, event_key, location_id)
);

CREATE INDEX idx_notification_rules_business ON notification_rules (business_id, event_key);

-- ---------------------------------------------------------------------------
-- The outbox
--
-- Producers INSERT here and return. The tick is what fans out. `dedupe_key` is
-- what makes a producer safe to call twice — the same shift closing, replayed
-- by a retried request, is one notification.
-- ---------------------------------------------------------------------------
CREATE TABLE notification_events (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id     uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    location_id     uuid REFERENCES locations(id) ON DELETE SET NULL,
    event_key       text NOT NULL,
    severity        text NOT NULL DEFAULT 'info' CHECK (severity IN ('info', 'important', 'critical')),
    -- Rendered by the producer, in Persian, at the moment it knew the facts —
    -- not re-derived later from a payload that may since have moved. A push
    -- notification is read on a lock screen with no way to ask a follow-up
    -- question, so the text has to stand alone.
    title           text NOT NULL,
    body            text NOT NULL DEFAULT '',
    -- Where tapping it should land. Relative, always: the notification is
    -- opened on whichever origin the user's business is served from.
    url             text NOT NULL DEFAULT '/dashboard',
    -- The money figure this event is about, when it has one — this is what
    -- notification_rules.min_amount_rial is compared against.
    amount_rial     bigint,
    payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
    dedupe_key      text NOT NULL,
    created_at      timestamptz NOT NULL DEFAULT now(),
    processed_at    timestamptz,
    UNIQUE (business_id, dedupe_key)
);

CREATE INDEX idx_notification_events_pending
    ON notification_events (business_id, created_at)
    WHERE processed_at IS NULL;

-- ---------------------------------------------------------------------------
-- The bell: one row per person per event they were entitled to hear about.
-- ---------------------------------------------------------------------------
CREATE TABLE notification_recipients (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id     uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    event_id        uuid NOT NULL REFERENCES notification_events(id) ON DELETE CASCADE,
    user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at      timestamptz NOT NULL DEFAULT now(),
    read_at         timestamptz,
    UNIQUE (event_id, user_id)
);

CREATE INDEX idx_notification_recipients_unread
    ON notification_recipients (business_id, user_id, created_at DESC)
    WHERE read_at IS NULL;

-- ---------------------------------------------------------------------------
-- The push attempts: one row per device per event.
-- ---------------------------------------------------------------------------
CREATE TABLE notification_deliveries (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id     uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    event_id        uuid NOT NULL REFERENCES notification_events(id) ON DELETE CASCADE,
    device_id       uuid NOT NULL REFERENCES notification_devices(id) ON DELETE CASCADE,
    user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    -- 'quiet' is not a failure: the person asked not to be woken, the bell row
    -- still exists, and recording it separately is how "why didn't my phone
    -- buzz" is answerable without guessing.
    status          text NOT NULL DEFAULT 'queued'
                        CHECK (status IN ('queued', 'sent', 'failed', 'expired', 'quiet')),
    http_status     smallint,
    error           text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    sent_at         timestamptz,
    UNIQUE (event_id, device_id)
);

CREATE INDEX idx_notification_deliveries_event ON notification_deliveries (business_id, event_id);

-- ---------------------------------------------------------------------------
-- Tenant isolation (Phase 12). platform_push_config is deliberately absent:
-- it holds one deployment-wide key pair and no business_id to scope by, the
-- same shape as platform_ai_config. It is listed in EXEMPT_TABLES.
-- ---------------------------------------------------------------------------
ALTER TABLE notification_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_devices FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON notification_devices FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE notification_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_rules FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON notification_rules FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE notification_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON notification_events FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE notification_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_recipients FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON notification_recipients FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE notification_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_deliveries FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON notification_deliveries FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
