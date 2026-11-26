import { NextResponse } from "next/server";
import { CONTRACT_VERSION } from "@/lib/contract";

export async function GET() {
  return NextResponse.json(
    {
      status: "ok",
      layer: "layer-1-bff",
      contract_version: CONTRACT_VERSION,
    },
    { status: 200 }
  );
}
