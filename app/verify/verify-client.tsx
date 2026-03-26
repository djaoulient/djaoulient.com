"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Loader2,
  CheckCircle,
  XCircle,
  Shield,
  Calendar,
  Ticket,
  AlertCircle,
  QrCode,
} from "lucide-react";
import { supabase } from "@/lib/supabase/client";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useTranslation } from "@/lib/contexts/TranslationContext";
import { t } from "@/lib/i18n/translations";

interface TicketData {
  purchase_id: string;
  customer_name: string;
  customer_email: string;
  customer_phone?: string;
  event_id: string;
  event_title: string;
  event_date_text: string;
  event_time_text: string;
  event_venue_name: string;
  ticket_type_id: string;
  ticket_name: string;
  quantity: number;
  price_per_ticket: number;
  total_amount: number;
  currency_code: string;
  status: string;
  is_used: boolean;
  used_at?: string;
  verified_by?: string;
  use_count?: number; // Admissions already used (legacy or purchase-level for individual QRs)
  total_quantity?: number; // Total admissions on this purchase (legacy quantity or individual row count)
  remaining_tickets?: number; // Calculated remaining admissions
}

const PIN_CACHE_KEY = "staff_verification_pin";
const PIN_CACHE_DURATION = 8 * 60 * 60 * 1000; // 8 hours in milliseconds

/** QR sometimes contains a full verify URL, wrapped quotes, or only the id query segment. */
function normalizeTicketIdentifier(raw: string): string {
  let s = raw.trim();
  if (!s) return s;
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    s = s.slice(1, -1).trim();
  }
  try {
    if (/^https?:\/\//i.test(s) && /verify/i.test(s)) {
      const u = new URL(s);
      const id = u.searchParams.get("id");
      if (id) {
        try {
          return decodeURIComponent(id).trim();
        } catch {
          return id.trim();
        }
      }
    }
  } catch {
    // not a usable URL
  }
  const idFromQuery = s.match(/[?&]id=([^&]+)/i);
  if (idFromQuery?.[1]) {
    try {
      return decodeURIComponent(idFromQuery[1]).trim();
    } catch {
      return idFromQuery[1].trim();
    }
  }
  return s;
}

// Audio feedback for scanning
const playSuccessSound = () => {
  try {
    const audioContext = new (
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext
    )();
    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();

    oscillator.connect(gainNode);
    gainNode.connect(audioContext.destination);

    oscillator.frequency.value = 800; // Higher pitch for success
    oscillator.type = "sine";

    gainNode.gain.setValueAtTime(0.3, audioContext.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(
      0.01,
      audioContext.currentTime + 0.1,
    );

    oscillator.start(audioContext.currentTime);
    oscillator.stop(audioContext.currentTime + 0.1);
  } catch {
    // Silent fail if audio not supported
  }
};

const playErrorSound = () => {
  try {
    const audioContext = new (
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext })
        .webkitAudioContext
    )();
    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();

    oscillator.connect(gainNode);
    gainNode.connect(audioContext.destination);

    oscillator.frequency.value = 200; // Lower pitch for error
    oscillator.type = "sawtooth";

    gainNode.gain.setValueAtTime(0.3, audioContext.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(
      0.01,
      audioContext.currentTime + 0.2,
    );

    oscillator.start(audioContext.currentTime);
    oscillator.stop(audioContext.currentTime + 0.2);
  } catch {
    // Silent fail if audio not supported
  }
};

// Enhanced storage with fallbacks for mobile compatibility
interface StaffCache {
  [key: string]: unknown;
}

declare global {
  interface Window {
    __staffCache?: StaffCache;
  }
}

const storage = {
  set: (key: string, value: unknown): boolean => {
    const data = JSON.stringify(value);
    try {
      // Try localStorage first (persists across browser sessions)
      localStorage.setItem(key, data);

      // Also set document cookie for cross-app/tab persistence
      if (typeof document !== "undefined") {
        const expires = new Date();
        expires.setTime(expires.getTime() + 8 * 60 * 60 * 1000); // 8 hours
        document.cookie = `${key}=${encodeURIComponent(data)};expires=${expires.toUTCString()};path=/;max-age=${8 * 60 * 60};SameSite=Lax`;
      }
      return true;
    } catch {
      try {
        // Fallback to sessionStorage
        sessionStorage.setItem(key, data);
        return true;
      } catch {
        // If both fail, store in memory (less reliable but better than nothing)
        window.__staffCache = window.__staffCache || {};
        window.__staffCache[key] = value;
        return true;
      }
    }
  },
  get: (key: string): unknown => {
    // Try cookie first as it's more reliable across sub-environments (like native camera to Safari transitions)
    try {
      if (typeof document !== "undefined") {
        const match = document.cookie.match(
          new RegExp("(^| )" + key + "=([^;]+)"),
        );
        if (match && match[2]) {
          return JSON.parse(decodeURIComponent(match[2]));
        }
      }
    } catch {
      // Ignore parse errors from cookies
    }

    try {
      // Try localStorage
      const data = localStorage.getItem(key);
      if (data) return JSON.parse(data);
    } catch {
      // Ignore parse errors
    }

    try {
      // Try sessionStorage
      const data = sessionStorage.getItem(key);
      if (data) return JSON.parse(data);
    } catch {
      // Ignore parse errors
    }

    try {
      // Try memory cache
      return window.__staffCache?.[key] || null;
    } catch {
      // Ignore access errors
    }

    return null;
  },
  remove: (key: string): void => {
    try {
      if (typeof document !== "undefined") {
        document.cookie = `${key}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/`;
      }
    } catch {
      // Ignore errors
    }
    try {
      localStorage.removeItem(key);
    } catch {
      // Ignore errors
    }
    try {
      sessionStorage.removeItem(key);
    } catch {
      // Ignore errors
    }
    try {
      if (window.__staffCache) {
        delete window.__staffCache[key];
      }
    } catch {
      // Ignore errors
    }
  },
};

interface VerifyClientProps {
  ticketId?: string;
}

export function VerifyClient({ ticketId: ticketIdProp }: VerifyClientProps) {
  const searchParams = useSearchParams();
  const ticketId =
    searchParams.get("id")?.trim() || ticketIdProp?.trim() || undefined;

  const { currentLanguage } = useTranslation();
  const [pin, setPin] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [ticketData, setTicketData] = useState<TicketData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [errorCode, setErrorCode] = useState<string | null>(null);
  const [isVerified, setIsVerified] = useState(false);
  const [wasJustAdmitted, setWasJustAdmitted] = useState(false);
  const [flashColor, setFlashColor] = useState<"green" | "red" | null>(null);

  // Guard: only fire one verification request per unique ticketId
  const verifiedTicketRef = useRef<string | null>(null);
  const isVerifiedRef = useRef(false);
  const verifyTicketFnRef = useRef<(id: string) => Promise<void>>(
    async () => {},
  );
  /** Bumps when `ticketId` changes so slow responses cannot overwrite UI (mobile / rapid scans). */
  const verifyGenerationRef = useRef(0);

  // Check for cached PIN on component mount
  useEffect(() => {
    const checkCachedPin = () => {
      try {
        const cached = storage.get(PIN_CACHE_KEY);
        if (cached) {
          // Check if it's the newer object format with timestamp
          if (
            typeof cached === "object" &&
            cached !== null &&
            "timestamp" in cached
          ) {
            const cacheObj = cached as { timestamp: number };
            const now = Date.now();

            // Check if cached PIN is still valid (within duration)
            if (now - cacheObj.timestamp < PIN_CACHE_DURATION) {
              setIsVerified(true);
              return;
            } else {
              // Clear expired cache
              storage.remove(PIN_CACHE_KEY);
            }
          }
          // Handle legacy format (raw PIN string/number saved before update)
          else if (typeof cached === "string" || typeof cached === "number") {
            // Upgrade to new format
            storage.set(PIN_CACHE_KEY, { timestamp: Date.now() });
            setIsVerified(true);
            return;
          }
        }
      } catch {
        // If there's any error reading cache, just ignore it
        storage.remove(PIN_CACHE_KEY);
      }
    };

    checkCachedPin();
  }, []);

  useEffect(() => {
    isVerifiedRef.current = isVerified;
  }, [isVerified]);

  // Reset state when ticketId changes (for continuous scanning workflow)
  useEffect(() => {
    if (ticketId) {
      verifyGenerationRef.current += 1;
      setError(null);
      setErrorCode(null);
      setTicketData(null);
      setWasJustAdmitted(false);
      verifiedTicketRef.current = null; // allow re-verification on new ticket
    }
  }, [ticketId]);

  // Auto-verify ticket when page loads with ID and user is verified
  // useRef guard ensures exactly ONE request fires per unique ticketId
  useEffect(() => {
    if (!ticketId || !isVerified) return;
    const normalized = normalizeTicketIdentifier(ticketId);
    if (verifiedTicketRef.current === normalized) return;
    verifiedTicketRef.current = normalized;
    verifyTicket(normalized);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticketId, isVerified]);

  // Helper to parse error codes from database exceptions
  const parseErrorMessage = (
    errorMessage: string,
  ): { code: string; message: string } => {
    const match = errorMessage.match(/^([A-Z_]+):\s*(.+)$/);
    if (match) {
      return { code: match[1], message: match[2] };
    }
    return { code: "UNKNOWN_ERROR", message: errorMessage };
  };

  // Helper to get user-friendly error message
  const getUserFriendlyError = useCallback(
    (errorCode: string, defaultMessage: string): string => {
      const errorMap: Record<string, string> = {
        TICKET_NOT_FOUND: t(
          currentLanguage,
          "ticketVerification.errors.ticketNotFound",
        ),
        INVALID_INPUT: t(
          currentLanguage,
          "ticketVerification.errors.ticketNotFound",
        ),
        VERIFICATION_FAILED: "Ticket verification failed. Please try again.",
        PROCESSING: "This ticket is currently being processed. Please wait.",
        ORPHANED_TICKET: "Ticket data is incomplete. Please contact support.",
        ALREADY_USED: t(
          currentLanguage,
          "ticketVerification.warnings.fullyUsed",
        ),
        DUPLICATE_SCAN: "Please wait a moment before scanning again.",
        ADMISSION_FAILED:
          "Ticket verified but admission failed. Please try again.",
        INTERNAL_ERROR: "System error. Please contact support.",
      };
      return errorMap[errorCode] || defaultMessage;
    },
    [currentLanguage],
  );

  const verifyTicket = useCallback(
    async (ticketIdentifier: string) => {
      const generation = ++verifyGenerationRef.current;
      setIsLoading(true);
      setError(null);
      setErrorCode(null);
      setTicketData(null);

      const trimmedId = normalizeTicketIdentifier(ticketIdentifier);

      const isStale = () => generation !== verifyGenerationRef.current;

      try {
        // Single direct call - edge function handles deduplication server-side
        const { data: response, error: edgeError } =
          await supabase.functions.invoke("verify-ticket", {
            body: {
              ticket_identifier: trimmedId,
              verified_by: "staff",
              auto_admit: true,
            },
          });

        if (isStale()) return;

        if (edgeError) {
          throw new Error(`Edge function error: ${edgeError.message}`);
        }

        if (!response || typeof response !== "object") {
          throw new Error("Invalid response from verification service");
        }

        const result = response as {
          success: boolean;
          ticket_data?: TicketData;
          error_code?: string;
          error_message?: string;
          admitted?: boolean;
        };

        if (result.ticket_data) {
          setTicketData(result.ticket_data);
        }

        if (!result.success) {
          const code = result.error_code || "UNKNOWN_ERROR";
          const msg = result.error_message || "Verification failed";
          const friendlyMessage = getUserFriendlyError(code, msg);
          setError(friendlyMessage);
          setErrorCode(code);
          playErrorSound();
          setFlashColor("red");
          setTimeout(() => setFlashColor(null), 500);
          return;
        }

        if (result.success && !result.admitted && result.error_code) {
          const code = result.error_code;
          const msg = result.error_message || "Admission failed";
          const friendlyMessage = getUserFriendlyError(code, msg);
          setError(friendlyMessage);
          setErrorCode(code);
          setFlashColor("red");
          setTimeout(() => setFlashColor(null), 500);
          return;
        }

        if (result.success && result.admitted) {
          setWasJustAdmitted(true);
          setError(null);
          setErrorCode(null);
          playSuccessSound();
          setFlashColor("green");
          setTimeout(() => setFlashColor(null), 300);
        }
      } catch (err) {
        if (isStale()) return;
        console.error("Verification error:", err);
        const errorMessage =
          err instanceof Error ? err.message : "Verification failed";
        const { code, message } = parseErrorMessage(errorMessage);
        const friendlyMessage = getUserFriendlyError(code, message);
        setError(friendlyMessage);
        setErrorCode(code);
        playErrorSound();
        setFlashColor("red");
        setTimeout(() => setFlashColor(null), 500);
      } finally {
        if (!isStale()) {
          setIsLoading(false);
        }
      }
    },
    [getUserFriendlyError],
  );

  useEffect(() => {
    verifyTicketFnRef.current = verifyTicket;
  }, [verifyTicket]);

  // iOS/Safari: camera handoff can restore this tab from bfcache with old React state
  // while the URL already points at a new ?id= — clear UI and re-verify from window.location.
  useEffect(() => {
    const onPageShow = (e: PageTransitionEvent) => {
      if (!e.persisted) return;
      verifyGenerationRef.current += 1;
      verifiedTicketRef.current = null;
      setTicketData(null);
      setError(null);
      setErrorCode(null);
      setWasJustAdmitted(false);
      const raw = new URLSearchParams(window.location.search).get("id");
      const normalized = raw ? normalizeTicketIdentifier(raw) : "";
      if (!normalized || !isVerifiedRef.current) return;
      verifiedTicketRef.current = normalized;
      void verifyTicketFnRef.current(normalized);
    };
    window.addEventListener("pageshow", onPageShow);
    return () => window.removeEventListener("pageshow", onPageShow);
  }, []);

  const handlePinSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsLoading(true);
    setError(null);

    try {
      // Call RPC function to verify PIN
      const { data: isValidPin, error: pinError } = await supabase.rpc(
        "verify_staff_pin",
        {
          p_pin: pin,
        },
      );

      if (pinError) {
        throw new Error(pinError.message);
      }

      if (isValidPin) {
        // Cache the PIN for future use with enhanced storage
        try {
          const cacheData = {
            timestamp: Date.now(),
          };
          storage.set(PIN_CACHE_KEY, cacheData);
        } catch {
          // If storage fails, continue anyway
          console.warn("Failed to cache PIN, but continuing...");
        }

        setIsVerified(true);
        setError(null);
        setPin("");
      } else {
        setError(t(currentLanguage, "ticketVerification.errors.invalidPin"));
        setPin("");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "PIN verification failed");
      setPin("");
    } finally {
      setIsLoading(false);
    }
  };

  // markTicketAsUsed is now handled by the edge function automatically
  // No separate admission function needed

  // Auto-admission is now handled by the edge function
  // No separate useEffect needed - verification includes admission

  // Get status colors and icons based on ticket state
  const getTicketStatus = () => {
    // Show slate/neutral styling for ALREADY_USED (ticket is valid, just previously scanned)
    if (error && errorCode === "ALREADY_USED") {
      return {
        bgColor: "bg-slate-50/50 dark:bg-slate-800/30",
        borderColor: "border-slate-300 dark:border-slate-600",
        textColor: "text-slate-700 dark:text-slate-300",
        icon: (
          <AlertCircle className="h-8 w-8 text-slate-600 dark:text-slate-400" />
        ),
        badgeVariant: "secondary" as const,
        badgeText: t(currentLanguage, "ticketVerification.badges.fullyUsed"),
        statusText: t(currentLanguage, "ticketVerification.status.fullyUsed"),
      };
    }

    // Show red styling for actual errors (ticket not found, invalid, unpaid, etc.)
    if (error) {
      return {
        bgColor: "bg-red-50/30 dark:bg-red-900/20",
        borderColor: "border-red-300 dark:border-red-700",
        textColor: "text-red-800 dark:text-red-200",
        icon: <XCircle className="h-8 w-8 text-red-600 dark:text-red-400" />,
        badgeVariant: "destructive" as const,
        badgeText: t(currentLanguage, "ticketVerification.badges.invalid"),
        statusText: t(currentLanguage, "ticketVerification.status.invalid"),
      };
    }

    // NEW: If we just successfully admitted this ticket, it is ALWAYS a valid scan (green)!
    if (wasJustAdmitted) {
      return {
        bgColor: "bg-green-50/30 dark:bg-green-900/20",
        borderColor: "border-green-300 dark:border-green-700",
        textColor: "text-green-800 dark:text-green-200",
        icon: (
          <CheckCircle className="h-8 w-8 text-green-600 dark:text-green-400" />
        ),
        badgeVariant: "default" as const,
        badgeText: t(currentLanguage, "ticketVerification.badges.valid"),
        statusText: t(currentLanguage, "ticketVerification.status.valid"),
      };
    }

    if (ticketData?.remaining_tickets === 0) {
      return {
        bgColor: "bg-slate-50/50 dark:bg-slate-800/30",
        borderColor: "border-slate-300 dark:border-slate-600",
        textColor: "text-slate-700 dark:text-slate-300",
        icon: (
          <AlertCircle className="h-8 w-8 text-slate-600 dark:text-slate-400" />
        ),
        badgeVariant: "secondary" as const,
        badgeText: t(currentLanguage, "ticketVerification.badges.fullyUsed"),
        statusText: t(currentLanguage, "ticketVerification.status.fullyUsed"),
      };
    }

    if (ticketData?.use_count !== undefined && ticketData.total_quantity) {
      const remaining = ticketData.total_quantity - ticketData.use_count;
      if (remaining <= 0) {
        // Fallback for logic consistency
        return {
          bgColor: "bg-slate-50/50 dark:bg-slate-800/30",
          borderColor: "border-slate-300 dark:border-slate-600",
          textColor: "text-slate-700 dark:text-slate-300",
          icon: (
            <AlertCircle className="h-8 w-8 text-slate-600 dark:text-slate-400" />
          ),
          badgeVariant: "secondary" as const,
          badgeText: t(currentLanguage, "ticketVerification.badges.fullyUsed"),
          statusText: t(currentLanguage, "ticketVerification.status.fullyUsed"),
        };
      }
    } else if (ticketData?.is_used) {
      // Fallback for legacy / simple tickets
      return {
        bgColor: "bg-slate-50/50 dark:bg-slate-800/30",
        borderColor: "border-slate-300 dark:border-slate-600",
        textColor: "text-slate-700 dark:text-slate-300",
        icon: (
          <AlertCircle className="h-8 w-8 text-slate-600 dark:text-slate-400" />
        ),
        badgeVariant: "secondary" as const,
        badgeText: t(currentLanguage, "ticketVerification.badges.fullyUsed"),
        statusText: t(currentLanguage, "ticketVerification.status.fullyUsed"),
      };
    }

    if (ticketData) {
      return {
        bgColor: "bg-green-50/30 dark:bg-green-900/20",
        borderColor: "border-green-300 dark:border-green-700",
        textColor: "text-green-800 dark:text-green-200",
        icon: (
          <CheckCircle className="h-8 w-8 text-green-600 dark:text-green-400" />
        ),
        badgeVariant: "default" as const,
        badgeText: t(currentLanguage, "ticketVerification.badges.valid"),
        statusText: t(currentLanguage, "ticketVerification.status.valid"),
      };
    }

    return null;
  };

  // If no ticket ID in URL, show manual entry with improved design
  if (!ticketId) {
    return (
      <>
        <div className="min-h-screen bg-background flex flex-col justify-center py-12 px-4">
          <div className="max-w-md mx-auto">
            <Card className="border border-blue-300 dark:border-blue-700 bg-blue-50/30 dark:bg-blue-900/20 rounded-sm">
              <CardHeader className="text-center pb-4">
                <div className="mx-auto w-16 h-16 bg-blue-100 dark:bg-blue-900/30 rounded-sm flex items-center justify-center mb-4">
                  <QrCode className="w-8 h-8 text-blue-600 dark:text-blue-400" />
                </div>
                <CardTitle className="text-2xl font-bold text-blue-800 dark:text-blue-200">
                  {t(currentLanguage, "ticketVerification.pageTitle")}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="text-center text-gray-300">
                  <p className="text-sm">
                    {t(
                      currentLanguage,
                      "ticketVerification.noTicketId.description",
                    )}
                  </p>
                </div>

                <div className="bg-blue-50/30 dark:bg-blue-900/20 border border-blue-300 dark:border-blue-700 rounded-sm p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <Ticket className="w-5 h-5 text-blue-600 dark:text-blue-400" />
                    <h3 className="font-semibold text-blue-800 dark:text-blue-200">
                      {t(
                        currentLanguage,
                        "ticketVerification.noTicketId.howToVerify.title",
                      )}
                    </h3>
                  </div>
                  <ul className="text-sm text-blue-700 dark:text-blue-300 space-y-1">
                    <li>
                      •{" "}
                      {t(
                        currentLanguage,
                        "ticketVerification.noTicketId.howToVerify.scanQr",
                      )}
                    </li>
                    <li>
                      •{" "}
                      {t(
                        currentLanguage,
                        "ticketVerification.noTicketId.howToVerify.enterPin",
                      )}
                    </li>
                    <li>
                      •{" "}
                      {t(
                        currentLanguage,
                        "ticketVerification.noTicketId.howToVerify.reviewDetails",
                      )}
                    </li>
                  </ul>
                </div>

                <div className="flex flex-col gap-3">
                  <Button asChild className="w-full">
                    <Link href="/">
                      <Calendar className="w-4 h-4 mr-2" />
                      {t(
                        currentLanguage,
                        "ticketVerification.noTicketId.backToEvents",
                      )}
                    </Link>
                  </Button>
                </div>

                <div className="text-center text-xs text-gray-500 dark:text-gray-400">
                  {t(currentLanguage, "ticketVerification.noTicketId.needHelp")}
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </>
    );
  }

  // Show PIN entry if not verified yet
  if (!isVerified) {
    return (
      <>
        <div className="min-h-screen bg-background flex flex-col justify-center py-12 px-4">
          <div className="max-w-md mx-auto">
            <Card className="border border-amber-300 dark:border-amber-700 bg-amber-50/30 dark:bg-amber-900/20 rounded-sm">
              <CardHeader className="text-center pb-4">
                <div className="mx-auto w-16 h-16 bg-amber-100 dark:bg-amber-900/30 rounded-sm flex items-center justify-center mb-4">
                  <Shield className="w-8 h-8 text-amber-600 dark:text-amber-400" />
                </div>
                <CardTitle className="text-2xl font-bold text-amber-800 dark:text-amber-200">
                  {t(currentLanguage, "ticketVerification.staffVerification")}
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="text-center text-gray-300">
                  <p className="text-lg mb-2">
                    {t(
                      currentLanguage,
                      "ticketVerification.pinEntry.description",
                    )}
                  </p>
                </div>

                <form onSubmit={handlePinSubmit} className="space-y-4">
                  <Input
                    type="password"
                    placeholder={t(
                      currentLanguage,
                      "ticketVerification.pinEntry.pinPlaceholder",
                    )}
                    value={pin}
                    onChange={(e) => setPin(e.target.value)}
                    maxLength={4}
                    className="text-center text-2xl tracking-widest h-12 rounded-sm bg-background border border-border"
                    disabled={isLoading}
                  />
                  <Button
                    type="submit"
                    className="w-full"
                    disabled={pin.length !== 4 || isLoading}
                    size="lg"
                  >
                    {isLoading ? (
                      <>
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        {t(
                          currentLanguage,
                          "ticketVerification.pinEntry.verifying",
                        )}
                      </>
                    ) : (
                      <>
                        <Shield className="mr-2 h-4 w-4" />
                        {t(
                          currentLanguage,
                          "ticketVerification.pinEntry.verifyButton",
                        )}
                      </>
                    )}
                  </Button>
                </form>

                {error && (
                  <div className="bg-red-50/30 dark:bg-red-900/20 border border-red-300 dark:border-red-700 rounded-sm p-4">
                    <div className="text-center text-red-600 dark:text-red-400 text-sm">
                      {error}
                    </div>
                  </div>
                )}

                <div className="text-center text-xs text-gray-500 dark:text-gray-400">
                  {t(currentLanguage, "ticketVerification.pinEntry.staffOnly")}
                </div>
              </CardContent>
            </Card>
          </div>
        </div>
      </>
    );
  }

  const status = getTicketStatus();

  // Show ticket details after PIN verification
  return (
    <>
      {/* Flash Feedback Overlay */}
      {flashColor && (
        <div
          className={`fixed inset-0 pointer-events-none z-50 ${
            flashColor === "green" ? "bg-green-500/30" : "bg-red-500/30"
          }`}
          style={{ animation: "flash 0.4s ease-out" }}
        />
      )}

      <div className="min-h-screen bg-background flex items-center justify-center px-4 py-8">
        <div className="w-full max-w-sm space-y-8">
          {/* Loading State */}
          {isLoading && !ticketData && (
            <Card className="rounded-lg border-0 shadow-sm">
              <CardContent className="py-12 text-center">
                <Loader2 className="h-8 w-8 animate-spin mx-auto mb-4 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">
                  {t(
                    currentLanguage,
                    "ticketVerification.loading.ticketDetails",
                  )}
                </p>
              </CardContent>
            </Card>
          )}

          {/* Status Card */}
          {status && (
            <Card
              className={`rounded-lg border ${status.borderColor} ${status.bgColor} shadow-sm`}
            >
              <CardContent className="px-8 py-12">
                <div className="flex flex-col items-center text-center space-y-8">
                  {status.icon}
                  <h2
                    className={`text-lg font-medium tracking-tight ${status.textColor}`}
                  >
                    {status.statusText}
                  </h2>
                  {ticketData && (
                    <div className="w-full space-y-6">
                      <p className="text-sm text-muted-foreground uppercase tracking-wider leading-relaxed">
                        {ticketData.ticket_name} — {ticketData.event_title}
                      </p>
                      <div className="space-y-1">
                        <p className="text-2xl font-semibold text-foreground tracking-tight">
                          {ticketData.customer_name}
                        </p>
                        <p className="text-sm text-muted-foreground">
                          {t(
                            currentLanguage,
                            "ticketVerification.quantity.scannedRemaining",
                            {
                              scannedCount:
                                ticketData.use_count != null
                                  ? ticketData.use_count
                                  : 1 - (ticketData.remaining_tickets || 0),
                              remainingCount:
                                ticketData.remaining_tickets != null
                                  ? ticketData.remaining_tickets
                                  : (ticketData.total_quantity || 1) -
                                    (ticketData.use_count || 0),
                            },
                          )}
                        </p>
                      </div>
                    </div>
                  )}
                  {error && (
                    <p
                      className={`text-sm ${
                        errorCode === "ALREADY_USED"
                          ? "text-muted-foreground"
                          : "text-destructive"
                      }`}
                    >
                      {error}
                    </p>
                  )}
                </div>
              </CardContent>
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
