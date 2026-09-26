/** (MSG-2) تبعيات webhooks الحقيقية — القاعدة. مفصولة ليبقى المنطق في messaging-webhooks قابلًا للاختبار. */
import { markDeliveryFailedByProvider, messagingChannelWithSecret, patientIdForInbound, recordMessageDelivery } from "./db";
import type { WebhookDeps } from "./messaging-webhooks";

export const webhookDeps: WebhookDeps = {
  async channel(channel) {
    const { view, secrets } = await messagingChannelWithSecret(channel);
    return { enabled: view.enabled, config: view.config as unknown as Record<string, unknown>, secrets };
  },
  patientFor: patientIdForInbound,
  async recordInbound({ channel, patientId, message }) {
    await recordMessageDelivery({
      channel,
      direction: "in",
      patientId,
      counterpart: message.from,
      body: message.body,
      purpose: "inbound",
      status: "received",
      providerMessageId: message.providerMessageId,
      createdBy: null,
    });
  },
  async markFailed(channel, providerMessageId, error) {
    await markDeliveryFailedByProvider(channel, providerMessageId, error);
  },
};
