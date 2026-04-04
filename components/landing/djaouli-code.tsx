"use client";

import { useState, useEffect } from "react";
import { useTranslation } from "@/lib/contexts/TranslationContext";
import { t } from "@/lib/i18n/translations";
import Image from "next/image";
import { motion, AnimatePresence } from "framer-motion";
import { createPortal } from "react-dom";
import { useIsMobile } from "@/lib/utils/use-is-mobile";

const codeItemsData = [
  {
    number: "1",
    titleKey: "djaouliCode.item1.title",
    descriptionKey: "djaouliCode.item1.description",
  },
  {
    number: "2",
    titleKey: "djaouliCode.item2.title",
    descriptionKey: "djaouliCode.item2.description",
  },
  {
    number: "3",
    titleKey: "djaouliCode.item3.title",
    descriptionKey: "djaouliCode.item3.description",
  },
  {
    number: "4",
    titleKey: "djaouliCode.item4.title",
    descriptionKey: "djaouliCode.item4.description",
  },
  {
    number: "5",
    titleKey: "djaouliCode.item5.title",
    descriptionKey: "djaouliCode.item5.description",
  },
  {
    number: "6",
    titleKey: "djaouliCode.item6.title",
    descriptionKey: "djaouliCode.item6.description",
  },
  {
    number: "7",
    titleKey: "djaouliCode.item7.title",
    descriptionKey: "djaouliCode.item7.description",
  },
  {
    number: "8",
    titleKey: "djaouliCode.item8.title",
    descriptionKey: "djaouliCode.item8.description",
  },
  {
    number: "9",
    titleKey: "djaouliCode.item9.title",
    descriptionKey: "djaouliCode.item9.description",
  },
  {
    number: "10",
    titleKey: "djaouliCode.item10.title",
    descriptionKey: "djaouliCode.item10.description",
  },
  {
    number: "11",
    titleKey: "djaouliCode.item11.title",
    descriptionKey: "djaouliCode.item11.description",
  },
];

interface DjaouliCodeDialogProps {
  isOpen: boolean;
  onClose: () => void;
}

export default function DjaouliCodeDialog({
  isOpen,
  onClose,
}: DjaouliCodeDialogProps) {
  const { currentLanguage } = useTranslation();
  const isMobile = useIsMobile();
  const [isMounted, setIsMounted] = useState(false);
  const [mobileVisibleHeight, setMobileVisibleHeight] = useState<number | null>(
    null,
  );

  useEffect(() => {
    setIsMounted(true);
    return () => setIsMounted(false);
  }, []);

  useEffect(() => {
    if (!isOpen) return;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prevOverflow;
    };
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || !isMobile || typeof window === "undefined") {
      setMobileVisibleHeight(null);
      return;
    }
    const vv = window.visualViewport;
    const apply = () => {
      setMobileVisibleHeight(
        vv ? Math.round(vv.height) : Math.round(window.innerHeight),
      );
    };
    apply();
    if (vv) {
      vv.addEventListener("resize", apply);
      vv.addEventListener("scroll", apply);
      return () => {
        vv.removeEventListener("resize", apply);
        vv.removeEventListener("scroll", apply);
      };
    }
    window.addEventListener("resize", apply);
    return () => window.removeEventListener("resize", apply);
  }, [isOpen, isMobile]);

  const handleClose = () => {
    localStorage.setItem("djaouli-code-shown", "true");
    onClose();
  };

  if (!isMounted) return null;

  const itemsToRender = codeItemsData.map((item) => (
    <CodeItem
      key={item.number}
      number={item.number}
      titleKey={item.titleKey}
      descriptionKey={item.descriptionKey}
      lang={currentLanguage}
    />
  ));

  return createPortal(
    <AnimatePresence>
      {isOpen && (
        <>
          <motion.div
            key="djaouli-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3, ease: "easeInOut" }}
            className="fixed inset-0 z-[60] bg-foreground/30 will-change-auto cursor-pointer"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              handleClose();
            }}
            aria-hidden="true"
            style={{
              position: "fixed",
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
            }}
          />

          {/* Panel: bottom sheet on mobile (matches purchase modal); from left on desktop (intentional) */}
          <motion.div
            key="djaouli-panel"
            role="dialog"
            aria-modal="true"
            aria-labelledby="djaouli-code-heading"
            {...(isMobile
              ? {
                  initial: { y: "100%" },
                  animate: { y: 0 },
                  exit: { y: "100%" },
                }
              : {
                  initial: { x: "-100%" },
                  animate: { x: 0 },
                  exit: { x: "-100%" },
                })}
            transition={{
              duration: isMobile ? 0.22 : 0.3,
              ease: isMobile ? [0.32, 0.72, 0, 1] : "easeInOut",
            }}
            className={
              isMobile
                ? "fixed inset-x-0 bottom-0 flex flex-col w-full max-h-[100dvh] z-[70] will-change-transform pointer-events-auto overscroll-contain"
                : "fixed top-0 bottom-0 left-0 flex flex-col w-full md:w-[500px] md:p-4 z-[70] will-change-transform pointer-events-auto overscroll-contain"
            }
            style={
              isMobile
                ? { position: "fixed", left: 0, right: 0, bottom: 0 }
                : { position: "fixed", top: 0, left: 0, bottom: 0 }
            }
            onClick={(e) => e.stopPropagation()}
          >
            <div
              className="flex flex-col w-full min-h-0 bg-[#1a1a1a] backdrop-blur-xl rounded-t-xl md:rounded-sm shadow-2xl py-4 px-3 md:px-4 h-[min(96dvh,100%)] md:h-full md:max-h-none"
              style={
                isMobile && mobileVisibleHeight != null
                  ? { maxHeight: mobileVisibleHeight }
                  : undefined
              }
            >
              <div className="flex items-center mb-4 flex-shrink-0">
                <div className="flex-1" id="djaouli-code-heading">
                  <Image
                    src="/code.webp"
                    alt="Djaouli Code"
                    width={140}
                    height={20}
                    className="object-contain"
                  />
                </div>
              </div>

              <div className="flex-1 min-h-0 overflow-y-auto overscroll-y-contain [-webkit-overflow-scrolling:touch]">
                <div className="py-2">
                  <div className="grid gap-3 grid-cols-1">{itemsToRender}</div>
                </div>
              </div>

              <div className="pt-3 border-t border-border mt-3 flex-shrink-0 pb-[max(0px,env(safe-area-inset-bottom))] md:pb-0">
                <button
                  type="button"
                  onClick={handleClose}
                  className="bg-teal-800 hover:bg-teal-700 text-teal-200 rounded-sm text-sm w-full font-medium min-h-11 h-11 md:h-10 transition-all shadow-lg hover:shadow-xl transform hover:scale-[0.98] active:scale-[0.95]"
                >
                  Gotcha!
                </button>
              </div>
            </div>
          </motion.div>
        </>
      )}
    </AnimatePresence>,
    document.body,
  );
}

interface CodeItemProps {
  number: string;
  titleKey: string;
  descriptionKey: string;
  lang: string;
}

function CodeItem({ number, titleKey, descriptionKey, lang }: CodeItemProps) {
  return (
    <div className="bg-muted/30 p-3 rounded-sm border border-slate-700">
      <div className="flex items-start gap-3">
        <div className="text-primary font-semibold text-sm flex-shrink-0">
          {number}.
        </div>
        <div className="flex-1">
          <h4 className="text-gray-100 font-bold text-sm uppercase leading-tight mb-2">
            {t(lang, titleKey)}
          </h4>
          <p className="text-gray-400 leading-relaxed text-sm">
            {t(lang, descriptionKey)}
          </p>
        </div>
      </div>
    </div>
  );
}
