import { NextRequest } from "next/server";

export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get("url");

  if (!url) {
    return new Response("Missing url parameter", { status: 400 });
  }

  try {
    const remoteResponse = await fetch(url);

    if (!remoteResponse.ok || !remoteResponse.body) {
      return new Response("Failed to fetch image", { status: 502 });
    }

    // Derive a filename from the remote URL
    const urlPath = new URL(url).pathname;
    const lastSegment =
      urlPath.substring(urlPath.lastIndexOf("/") + 1) || "image";
    const filename = lastSegment.includes(".")
      ? lastSegment
      : `${lastSegment}.jpg`;

    const contentType =
      remoteResponse.headers.get("content-type") ?? "application/octet-stream";

    return new Response(remoteResponse.body, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
  } catch (err) {
    console.error("Error proxying image download", err);
    return new Response("Error downloading image", { status: 500 });
  }
}
