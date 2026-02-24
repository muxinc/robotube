import Apple from "@auth/core/providers/apple";
import Google from "@auth/core/providers/google";
import { convexAuth } from "@convex-dev/auth/server";

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [
    Google,
    Apple({
      profile: (appleInfo: any) => {
        const sharedUser = appleInfo.user;
        const name = sharedUser
          ? `${sharedUser.name.firstName} ${sharedUser.name.lastName}`
          : undefined;

        return {
          id: appleInfo.sub,
          name,
          email: appleInfo.email,
        };
      },
    }),
  ],
});
