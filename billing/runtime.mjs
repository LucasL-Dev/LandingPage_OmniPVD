import { Resend } from 'resend';
import { createBilling } from './service.mjs';

export function billingRuntime(stripe, projectRoot, priceId, limits = {}) {
  if (!stripe || !process.env.BILLING_DB_PATH) return null;
  return createBilling({
    stripe,
    resend: process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null,
    config: {
      projectRoot, priceId, ...limits,
      dbPath: process.env.BILLING_DB_PATH,
      emailEnabled: process.env.AUTO_WELCOME_EMAIL_ENABLED === 'true',
      downloadEnabled: process.env.PRIVATE_DOWNLOAD_ENABLED === 'true',
      installerPath: process.env.PRIVATE_INSTALLER_PATH,
      downloadOrigin: process.env.DOWNLOAD_ORIGIN,
      from: process.env.RESEND_FROM,
      supportEmail: process.env.SUPPORT_EMAIL,
    },
  });
}
