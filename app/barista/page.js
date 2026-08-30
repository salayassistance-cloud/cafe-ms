'use client';

import KitchenDisplay from '@/app/components/KitchenDisplay';

// Barista workstation — mounts the shared KDS board locked to the BARISTA
// station, so only drink/barista tickets are displayed.

export default function BaristaPage() {
  return (
    <KitchenDisplay
      station="DRINK"
      stationLabel="BARISTA ONLY"
      title="BARISTA"
    />
  );
}