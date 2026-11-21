import { getHotelServerSession } from "@/lib/hotel/auth/serverSession";
import HotelSessionGate from "@/app/components/hotel/HotelSessionGate";
import HotelLoginGate from "@/app/components/hotel/HotelLoginGate";
import HotelCacheGuard from "@/app/components/hotel/HotelCacheGuard";
import { HotelSessionProvider } from "@/app/components/hotel/HotelSessionProvider";

// Hotel-wide session gate. The session is verified on the server using the
// Hotel-only cookie and Hotel database connection, exactly as POS route layouts
// verify their sessions. Because this layout is preserved across client
// navigation between Hotel sub-pages, verification happens once per entry
// instead of once per page component mount.
//
// No POS session, guard, or database code is imported.

export const dynamic = "force-dynamic";

export default async function HotelLayout({ children }) {
  const result = await getHotelServerSession();
  if (!result.ok) {
    // A configuration/database failure cannot authenticate anyone: keep the
    // neutral unavailable notice. A missing/expired session shows the approved
    // identity + PIN sign-in gate.
    if (result.reason === "unavailable") {
      return (
        <>
          <HotelCacheGuard />
          <HotelSessionGate reason={result.reason} />
        </>
      );
    }
    return (
      <>
        <HotelCacheGuard />
        <HotelLoginGate />
      </>
    );
  }

  return (
    <>
      <HotelCacheGuard />
      <HotelSessionProvider session={result.session}>
        {children}
      </HotelSessionProvider>
    </>
  );
}
