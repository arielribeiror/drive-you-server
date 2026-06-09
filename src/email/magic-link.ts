import { Resend } from "resend";

import { config } from "../config.js";

const resend = config.resendApiKey ? new Resend(config.resendApiKey) : null;

export const sendMagicLinkEmail = async (email: string, magicLink: string) => {
  if (!resend) {
    console.info(`[magic-link] ${email}: ${magicLink}`);

    return {
      sent: false,
      reason: "RESEND_API_KEY is not configured.",
    };
  }

  await resend.emails.send({
    from: config.resendFromEmail,
    to: email,
    subject: "Seu link de acesso ao Drive You",
    text: `Use este link para acessar o Drive You: ${magicLink}\n\nO link expira em ${config.magicLinkTtlMinutes} minutos.`,
    html: `
      <div style="font-family: Arial, sans-serif; color: #111; line-height: 1.5;">
        <h1 style="font-size: 22px;">Acesse o Drive You</h1>
        <p>Use o botão abaixo para entrar no app. O link expira em ${config.magicLinkTtlMinutes} minutos.</p>
        <p>
          <a href="${magicLink}" style="display: inline-block; background: #111; color: #fff; padding: 12px 18px; border-radius: 12px; text-decoration: none;">
            Entrar no Drive You
          </a>
        </p>
        <p>Se o botão não funcionar, copie e cole este link:</p>
        <p>${magicLink}</p>
      </div>
    `,
  });

  return { sent: true };
};
