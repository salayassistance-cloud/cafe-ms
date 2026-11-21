"use client";

// Layout-scoped Hotel session state.
//
// The /hotel server layout validates any pre-existing session once per entry
// and passes the result here. This provider lives in the layout, so it is
// preserved across client navigation between Hotel sub-pages. It never issues
// or refreshes a credential; the Hotel interactive login implementation has
// been removed.
//
// The CSRF token is never written to storage, a URL, or the DOM; it is held in
// memory only and forwarded by hotelRequest on mutations. Authorization remains
// server-authoritative: every API request still authenticates the live session.

import { createContext, useContext } from "react";

const HotelSessionContext = createContext(null);

export function HotelSessionProvider({ session, children }) {
  return (
    <HotelSessionContext.Provider value={session}>
      {children}
    </HotelSessionContext.Provider>
  );
}

export function useHotelSession() {
  return useContext(HotelSessionContext);
}
