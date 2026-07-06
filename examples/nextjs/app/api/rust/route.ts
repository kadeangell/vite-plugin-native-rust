import { NextResponse } from "next/server";
import { add, sumTo } from "../../../lib/native.server";

// Always execute in the server function (never prerendered), so curling this
// route proves the native addon loads and runs on the deploy target.
export const dynamic = "force-dynamic";

export async function GET() {
  const addResult = add(2, 3); // expected: 5
  const sumToResult = await sumTo(1000); // expected: 500500

  return NextResponse.json({
    add: addResult,
    sumTo: sumToResult,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
  });
}
