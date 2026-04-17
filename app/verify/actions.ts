"use server";

import { cookies } from "next/headers";

const PIN_CACHE_KEY = "staff_verification_pin";
const PIN_CACHE_DURATION = 8 * 60 * 60 * 1000; // 8 hours in milliseconds
const PIN_CACHE_MAX_AGE_SEC = 8 * 60 * 60;

export async function setStaffPinCookie() {
  const cookieStore = await cookies();
  const expires = Date.now() + PIN_CACHE_DURATION;

  cookieStore.set(PIN_CACHE_KEY, JSON.stringify({ timestamp: Date.now() }), {
    expires: new Date(expires),
    maxAge: PIN_CACHE_MAX_AGE_SEC,
    path: "/",
    httpOnly: true, // More secure, prevents client-side JS read, functions like a real auth session
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
  });
}
