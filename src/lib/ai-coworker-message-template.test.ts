import { describe, expect, it } from "vitest";
import { buildCoworkerActions, validateTemplateParams } from "./ai-coworker-templates";
import { AUTOPILOT_DEFAULTS, evaluateAutopilotProposal } from "./ai-autopilot";
import { ACTION_CATALOG } from "./ai";

const params = { channel: "sms", templateId: "template-1", projectId: "project-1" };
const facts = { triggerCustomer: { customerId: "customer-1", eventKind: "customer_birthday" as const } };

describe("Phase 37b event-message coworker template", () => {
  it("is deterministic and creates a one-recipient queue action, never a provider action", () => {
    const first = buildCoworkerActions("customer_event_message", params, facts);
    const second = buildCoworkerActions("customer_event_message", params, facts);
    expect(first).toEqual(second);
    expect(first.actions).toEqual([expect.objectContaining({
      type: "messaging.campaign.trigger",
      payload: expect.objectContaining({ customerId: "customer-1", templateId: "template-1", channel: "sms", projectId: "project-1" }),
    })]);
    expect(ACTION_CATALOG["messaging.campaign.trigger"].coworkerOnly).toBe(true);
  });

  it("rejects an unconfigured channel/template and skips if the source customer vanished", () => {
    expect(validateTemplateParams("customer_event_message", {})).toEqual(expect.arrayContaining([
      "coworker_params_message_channel_invalid", "coworker_params_message_template_invalid",
    ]));
    expect(buildCoworkerActions("customer_event_message", params, {}).actions).toEqual([]);
  });

  it("holds automatic sends without an exact current cost, and at the messaging Rial cap", () => {
    const action = buildCoworkerActions("customer_event_message", params, facts).actions[0];
    const setting = { ...AUTOPILOT_DEFAULTS.messaging, enabled: true, maxAmountRial: 1_000 };
    expect(evaluateAutopilotProposal({ meta: ACTION_CATALOG[action.type], payload: action.payload, setting, appliedTodayInCategory: 0, context: {} }))
      .toMatchObject({ decision: "needs_confirmation", reasonCode: "missing_context" });
    expect(evaluateAutopilotProposal({ meta: ACTION_CATALOG[action.type], payload: action.payload, setting, appliedTodayInCategory: 0, context: { messageCostRial: 1_001 } }))
      .toMatchObject({ decision: "needs_confirmation", reasonCode: "amount_over_cap" });
    expect(evaluateAutopilotProposal({ meta: ACTION_CATALOG[action.type], payload: action.payload, setting, appliedTodayInCategory: 0, context: { messageCostRial: 1_000 } }))
      .toMatchObject({ decision: "auto_apply" });
  });
});
