import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { authConfig } from "@/auth.config";

/**
 * A real bcrypt hash of a value nobody can supply, compared against when the
 * email is unknown. Its only job is to cost the same as a genuine check.
 */
const DUMMY_HASH = "$2b$10$CwTycUXWue0Thq9StjUM0uJ8.e0Ej1mZQ5m5YQ3n5J9Ks8QJ8m5Wu";

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  providers: [
    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      authorize: async (credentials) => {
        const rawEmail = credentials?.email as string | undefined;
        const password = credentials?.password as string | undefined;
        if (!rawEmail || !password) return null;

        // Matches how registration stores it, so capitalisation cannot lock
        // someone out of their own account.
        const email = rawEmail.trim().toLowerCase();
        const user = await prisma.user.findUnique({ where: { email } });

        // A bcrypt comparison runs even when the account does not exist, so an
        // unknown email and a wrong password take the same time to reject. A
        // fast "no" would otherwise let an attacker enumerate who has accounts.
        const hash = user?.passwordHash ?? DUMMY_HASH;
        const valid = await bcrypt.compare(password, hash);
        if (!user || !valid) return null;

        return { id: user.id, name: user.name, email: user.email };
      },
    }),
  ],
});
