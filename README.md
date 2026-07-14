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

## Railway deploy

This service is ready to deploy on Railway using the Dockerfile in this folder.

1. Create a new Railway project from the `drive-you-server` GitHub repository.
2. If deploying from a monorepo instead, set the service root directory to `drive-you-server`.
3. Add a PostgreSQL database to the same Railway project and the same environment as the API service.
4. Open the API service variables and add `DATABASE_URL` as a reference to the PostgreSQL service. The service name in the reference must match the exact PostgreSQL service name shown in the Railway canvas. If the database service is named `PostgreSQL`, use:

```bash
DATABASE_URL=${{PostgreSQL.DATABASE_URL}}
```

If the database service has another name, replace `PostgreSQL` with that exact name. Prefer Railway's reference variable picker/autocomplete instead of typing it manually.

5. Add the remaining API variables. The minimum production set is:

```bash
NODE_ENV=production
JWT_SECRET=<32+ character secret>
MAGIC_LINK_BASE_URL=driveyou://auth/magic-link
CORS_ORIGIN=*
NOTIFICATION_WORKER_ENABLED=true
```

You can generate a JWT secret locally with:

```bash
openssl rand -base64 48
```

For easier setup, copy `.env.railway.example` into Railway's Variables -> Raw Editor and replace placeholders/secrets. Railway does not block the first GitHub deploy to ask for missing environment variables; failed startup usually means the API service variables are incomplete.

Optional variables:

```bash
GOOGLE_WEB_CLIENT_ID=<same web client id used by the app>
GOOGLE_IOS_CLIENT_ID=<optional ios client id>
GOOGLE_ANDROID_CLIENT_ID=<optional android client id>
APPLE_CLIENT_IDS=<optional comma-separated Apple audiences>
APPLE_BUNDLE_ID=com.driveyou.app
RESEND_API_KEY=<optional, only when testing real email delivery>
RESEND_FROM_EMAIL=Drive You <auth@driveyou.app>
OPENAI_API_KEY=<optional, only for odometer image reading>
EXPO_PUSH_ACCESS_TOKEN=<optional Expo push access token>
```

The Docker image runs `npx prisma migrate deploy` before `node dist/index.js`, so pending Prisma migrations are applied on each deploy before the API starts.

Use `https://api.driveyou.app` as `EXPO_PUBLIC_API_URL` when building the Android APK.

Google Sign-In requires every OAuth audience that can appear in app tokens to be configured in the API. Keep the app Web Client ID in `GOOGLE_WEB_CLIENT_ID`; for iOS native sign-in also copy the iOS OAuth Client ID into `GOOGLE_IOS_CLIENT_ID`. Alternatively, include all accepted audiences in `GOOGLE_CLIENT_IDS`.

## Magic link email

Magic link delivery uses Resend when `RESEND_API_KEY` is configured.

Set these values in `.env`:

```bash
RESEND_API_KEY=re_...
RESEND_FROM_EMAIL=Drive You <auth@driveyou.app>
```

`RESEND_FROM_EMAIL` must use a sender/domain verified in Resend. A mailbox does not need to exist for `auth@driveyou.app` as long as the sending domain is verified in Resend, but replies/bounces should be handled separately when we polish production email. When `RESEND_API_KEY` is empty in development, the API does not send email and logs the magic link plus the 6-digit code instead.

## Odometer image reading

Dashboard photo reading during onboarding is optional. Set `OPENAI_API_KEY` to enable it; otherwise the API returns a controlled error and the app falls back to manual mileage entry.

```bash
OPENAI_API_KEY=sk-...
ODOMETER_READING_MODEL=gpt-5.5
```
