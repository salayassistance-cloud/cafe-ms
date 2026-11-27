import ReceptionUI from "@/app/components/hotel/ReceptionUI";

export const dynamic = "force-dynamic";

export const metadata = {
  title: "Reception · Bono Hotel",
  description:
    "Hotel front-desk reception for guests, reservations, check-in, check-out, and recorded payments.",
};

export default function HotelReceptionPage() {
  return <ReceptionUI />;
}
