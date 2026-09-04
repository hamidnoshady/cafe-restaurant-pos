-- ============================================================================
-- 0134_message_campaigns.sql — Phase 37 Wave 2.
--
-- The structure of a campaign: what text (a template), to which segment, when,
-- and what became of each message. Four tenant tables, every one with its RLS
-- policy here (the repo's standing rule; integration/tenant-isolation asserts it
-- over the live schema).
--
--  message_templates    a body with a closed {{…}} variable set (validated in
--                       src/lib/message-template.ts at save time).
--  message_campaigns    one send job: channel, template, segment, schedule,
--                       status and running result counters.
--  message_recipients   a *snapshot* of who was sent to at send time — the
--                       customer id, the normalized address and the rendered
--                       text frozen the moment the send happened. A segment is
--                       dynamic; "who we told" is a historical fact and must
--                       not change when the segment later gains a member. This
--                       is the same reason a sale document stores the price of
--                       the day, not today's price.
--  message_outbox       the send queue: per-recipient attempts, backoff,
--                       provider id and outcome. Only the background tick
--                       (server.ts) drains it — nothing is sent inline.
--
-- Consent is NOT enforced here. A recipient row is written only for a member
-- the audience resolver handed back for this channel (resolveSegment with the
-- channel's purpose, which filters on consent *and* a reachable address). This
-- table never re-filters and never contains an unconsented member.
-- ============================================================================

CREATE TABLE message_templates (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id   uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    channel       text NOT NULL CHECK (channel IN ('sms', 'email')),
    name          text NOT NULL CHECK (btrim(name) <> ''),
    subject       text NOT NULL DEFAULT '',
    body          text NOT NULL CHECK (btrim(body) <> ''),
    created_by    text NOT NULL DEFAULT '',
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_message_templates_business ON message_templates (business_id, channel);

CREATE TABLE message_campaigns (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id           uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    channel               text NOT NULL CHECK (channel IN ('sms', 'email')),
    name                  text NOT NULL CHECK (btrim(name) <> ''),
    template_id           uuid REFERENCES message_templates(id) ON DELETE SET NULL,
    -- The saved segment the audience was resolved from at send time. Null for a
    -- triggered single-recipient campaign (Wave 5) which names its target by
    -- event rather than by membership of a group.
    segment_id            uuid REFERENCES customer_segments(id) ON DELETE SET NULL,
    -- Phase 37 Wave 5: campaigns may be charged to a project (cost centre).
    -- FK added to ai_projects; nullable so an unassigned campaign stays legal.
    project_id            uuid REFERENCES ai_projects(id) ON DELETE SET NULL,
    scheduled_at          timestamptz,
    status                text NOT NULL DEFAULT 'draft' CHECK (status IN (
                              'draft', 'sending', 'paused', 'completed', 'failed'
                          )),
    -- For a triggered (Wave 5) campaign, which event created it. Manual
    -- campaigns keep this empty.
    triggered_by          text NOT NULL DEFAULT '',
    -- Result counters, updated by the outbox tick as rows drain.
    total_recipients      integer NOT NULL DEFAULT 0 CHECK (total_recipients >= 0),
    sent_count            integer NOT NULL DEFAULT 0 CHECK (sent_count >= 0),
    delivered_count       integer NOT NULL DEFAULT 0 CHECK (delivered_count >= 0),
    failed_count          integer NOT NULL DEFAULT 0 CHECK (failed_count >= 0),
    -- Wave 4 posting: has this campaign's real-send cost been posted to the
    -- ledger (one document per campaign)? Guarded by the posting service so a
    -- completed campaign posts exactly once.
    cost_posted           boolean NOT NULL DEFAULT false,
    cost_posted_entry_id  uuid,
    created_by            text NOT NULL DEFAULT '',
    started_at            timestamptz,
    completed_at          timestamptz,
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_message_campaigns_business_created
    ON message_campaigns (business_id, created_at DESC);
CREATE INDEX idx_message_campaigns_segment ON message_campaigns (segment_id)
    WHERE segment_id IS NOT NULL;
CREATE INDEX idx_message_campaigns_ready_to_post
    ON message_campaigns (business_id) WHERE status = 'completed' AND cost_posted = false;

CREATE TABLE message_recipients (
    id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id   uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    campaign_id   uuid NOT NULL REFERENCES message_campaigns(id) ON DELETE CASCADE,
    customer_id   uuid REFERENCES customers(id) ON DELETE SET NULL,
    channel       text NOT NULL CHECK (channel IN ('sms', 'email')),
    -- The normalized destination: phone (E.164 when we could normalize it) or
    -- an email address. A frozen fact at snapshot time.
    address       text NOT NULL,
    subject       text NOT NULL DEFAULT '',
    -- The rendered body, frozen at snapshot time so history never rewrites.
    body          text NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX idx_message_recipients_campaign ON message_recipients (campaign_id);
CREATE INDEX idx_message_recipients_customer ON message_recipients (customer_id)
    WHERE customer_id IS NOT NULL;

CREATE TABLE message_outbox (
    id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    business_id           uuid NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
    recipient_id          uuid NOT NULL REFERENCES message_recipients(id) ON DELETE CASCADE,
    campaign_id           uuid NOT NULL REFERENCES message_campaigns(id) ON DELETE CASCADE,
    status                text NOT NULL DEFAULT 'queued' CHECK (status IN (
                              'queued', 'sending', 'sent', 'delivered', 'failed'
                          )),
    attempts              integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    max_attempts          integer NOT NULL DEFAULT 3 CHECK (max_attempts BETWEEN 1 AND 10),
    next_attempt_at       timestamptz NOT NULL DEFAULT now(),
    provider_message_id   text,
    error                 text,
    sent_at               timestamptz,
    last_attempt_at       timestamptz,
    created_at            timestamptz NOT NULL DEFAULT now(),
    updated_at            timestamptz NOT NULL DEFAULT now()
);
-- The drain query for the per-business tick: queued rows whose backoff has
-- elapsed, oldest first.
CREATE INDEX idx_message_outbox_drain
    ON message_outbox (business_id, next_attempt_at) WHERE status = 'queued';
CREATE INDEX idx_message_outbox_campaign ON message_outbox (campaign_id);

ALTER TABLE message_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_templates FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON message_templates FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE message_campaigns ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_campaigns FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON message_campaigns FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE message_recipients ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_recipients FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON message_recipients FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());

ALTER TABLE message_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE message_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON message_outbox FOR ALL
    USING (app_rls_bypass() OR business_id = app_current_business())
    WITH CHECK (app_rls_bypass() OR business_id = app_current_business());
