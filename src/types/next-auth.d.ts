import type { DefaultSession, DefaultUser } from "next-auth";

/**
 * next-auth v4 module augmentation (Task 7-a).
 *
 * The JWT/session carry { id, email, name, role } for the credentials
 * strategy — see src/lib/auth/options.ts callbacks.
 */

declare module "next-auth" {
  interface Session {
    user: {
      id: string;
      email: string | null;
      name: string | null;
      role: string;
    } & DefaultSession["user"];
  }

  interface User extends DefaultUser {
    role?: string;
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    id?: string;
    email?: string;
    name?: string;
    role?: string;
  }
}
