# Drive You API

Fastify + Prisma + Postgres API for Drive You authentication.

## Local setup

1. Copy `.env.example` to `.env` and fill provider credentials.
2. Start Postgres:

```bash
docker compose up -d
```

3. Generate Prisma Client and run migrations:

```bash
npm run prisma:generate
npm run prisma:migrate
```

4. Start the API:

```bash
npm run dev
```

For Waydroid, set `EXPO_PUBLIC_API_URL=http://192.168.240.1:3333` in the app. For physical mobile devices, use your machine LAN URL, for example `http://192.168.0.10:3333`.

Google Sign-In requires every OAuth audience that can appear in app tokens to be configured in the API. Keep the app Web Client ID in `GOOGLE_WEB_CLIENT_ID`; for iOS native sign-in also copy the iOS OAuth Client ID into `GOOGLE_IOS_CLIENT_ID`. Alternatively, include all accepted audiences in `GOOGLE_CLIENT_IDS`.

## Magic link email

Magic link delivery uses Resend when `RESEND_API_KEY` is configured.

Set these values in `.env`:

```bash
RESEND_API_KEY=re_...
RESEND_FROM_EMAIL=Drive You <auth@your-verified-domain.com>
```

`RESEND_FROM_EMAIL` must use a sender/domain verified in Resend. When `RESEND_API_KEY` is empty in development, the API does not send email and logs the magic link plus the 6-digit code instead.
