import { Account } from "@/components/account";
import { PageHead } from "@/components/site";

export const metadata = { title: "Account · branchr" };

export default function Page() {
  return (
    <>
      <PageHead title="Your account">Sign in with Discord. The same sign-in works in the web app.</PageHead>
      <section className="mx-auto max-w-6xl px-4 py-12 sm:px-6">
        <Account />
      </section>
    </>
  );
}
