'use client';

import KitchenDisplay from '@/app/components/KitchenDisplay';

// Kitchen workstation — mounts the shared KDS board locked to the KITCHEN
// station, so only food/kitchen tickets are displayed.

export default function KdsPage() {
  return (
    <KitchenDisplay
      station="FOOD"
      stationLabel="KITCHEN ONLY"
      title="KITCHEN"
    />
  );
}