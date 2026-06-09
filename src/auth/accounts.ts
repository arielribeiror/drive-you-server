import { AuthProvider, Prisma, type PrismaClient, type User } from "@prisma/client";

import { isApplePrivateRelayEmail, normalizeEmail } from "./crypto.js";

export type VerifiedIdentity = {
  provider: AuthProvider;
  providerSubject: string;
  email?: string | null;
  emailVerified: boolean;
  isPrivateEmail?: boolean;
  name?: string | null;
  avatarUrl?: string | null;
};

const isUniqueConstraintError = (error: unknown) =>
  error instanceof Prisma.PrismaClientKnownRequestError &&
  error.code === "P2002";

const canLinkByEmail = (identity: VerifiedIdentity, emailNormalized: string | null) =>
  Boolean(
    emailNormalized &&
      identity.emailVerified &&
      !identity.isPrivateEmail &&
      !(
        identity.provider === AuthProvider.apple &&
        isApplePrivateRelayEmail(identity.email)
      ),
  );

const maybeUpdateUserProfile = async (
  tx: PrismaClient | Prisma.TransactionClient,
  user: User,
  identity: VerifiedIdentity,
  emailNormalized: string | null,
) => {
  const data: Prisma.UserUpdateInput = {};

  if (!user.email && identity.email && identity.emailVerified) {
    data.email = identity.email;
  }

  if (!user.emailNormalized && emailNormalized && canLinkByEmail(identity, emailNormalized)) {
    data.emailNormalized = emailNormalized;
  }

  if (!user.name && identity.name) {
    data.name = identity.name;
  }

  if (!user.avatarUrl && identity.avatarUrl) {
    data.avatarUrl = identity.avatarUrl;
  }

  if (Object.keys(data).length === 0) {
    return user;
  }

  return tx.user.update({
    where: { id: user.id },
    data,
  });
};

export const findOrCreateUserForIdentity = async (
  tx: PrismaClient | Prisma.TransactionClient,
  identity: VerifiedIdentity,
) => {
  const existingIdentity = await tx.authIdentity.findUnique({
    where: {
      provider_providerSubject: {
        provider: identity.provider,
        providerSubject: identity.providerSubject,
      },
    },
    include: { user: true },
  });

  const emailNormalized =
    identity.email && identity.emailVerified ? normalizeEmail(identity.email) : null;

  if (existingIdentity) {
    await tx.authIdentity.update({
      where: { id: existingIdentity.id },
      data: {
        email: identity.email ?? existingIdentity.email,
        emailNormalized: emailNormalized ?? existingIdentity.emailNormalized,
        emailVerified: identity.emailVerified,
        isPrivateEmail: Boolean(identity.isPrivateEmail),
      },
    });

    return maybeUpdateUserProfile(
      tx,
      existingIdentity.user,
      identity,
      emailNormalized,
    );
  }

  const linkableByEmail = canLinkByEmail(identity, emailNormalized);
  let user =
    linkableByEmail && emailNormalized
      ? await tx.user.findUnique({ where: { emailNormalized } })
      : null;

  if (!user) {
    try {
      user = await tx.user.create({
        data: {
          email: identity.email ?? null,
          emailNormalized: emailNormalized,
          name: identity.name ?? null,
          avatarUrl: identity.avatarUrl ?? null,
        },
      });
    } catch (error) {
      if (!isUniqueConstraintError(error) || !emailNormalized) {
        throw error;
      }

      user = await tx.user.findUniqueOrThrow({ where: { emailNormalized } });
    }
  } else {
    user = await maybeUpdateUserProfile(tx, user, identity, emailNormalized);
  }

  try {
    await tx.authIdentity.create({
      data: {
        userId: user.id,
        provider: identity.provider,
        providerSubject: identity.providerSubject,
        email: identity.email ?? null,
        emailNormalized,
        emailVerified: identity.emailVerified,
        isPrivateEmail: Boolean(identity.isPrivateEmail),
      },
    });
  } catch (error) {
    if (!isUniqueConstraintError(error)) {
      throw error;
    }
  }

  return user;
};
