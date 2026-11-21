'use client';

import KitchenDisplay from '@/app/components/KitchenDisplay';

// JEBENA BUNA workstation — mounts the shared KDS board locked to the
// HOT_DRINK station, so only coffee/hot-drink tickets are displayed.

export default function JebenaPage() {
  return (
    <KitchenDisplay
      station="HOT_DRINK"
      stationLabel="JEBENA BUNA ONLY"
      title="JEBENA BUNA"
    />
  );
}
