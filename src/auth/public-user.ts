import type { User } from "@prisma/client";

export type PublicUser = {
  id: string;
  email: string | null;
  name: string | null;
  avatarUrl: string | null;
};

export const toPublicUser = (user: User): PublicUser => ({
  id: user.id,
  email: user.email,
  name: user.name,
  avatarUrl: user.avatarUrl,
});
