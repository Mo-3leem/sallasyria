"use client";

import Link from "next/link";
import { useState } from "react";
import { Navbar } from "@/components/Navbar";
import { Button, Card, Container } from "@/components/ui";

/* ---------- inline SVG icons (no extra dependencies) ---------- */

function Icon({ d, className = "h-6 w-6" }: { d: string; className?: string }) {
  return (
    <svg
      className={className}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path strokeLinecap="round" strokeLinejoin="round" d={d} />
    </svg>
  );
}

const PATHS = {
  store:
    "M3 9l1.5-5h15L21 9M3 9h18M3 9v11a1 1 0 001 1h16a1 1 0 001-1V9M9 21v-6h6v6",
  laptop: "M4 5h16a1 1 0 011 1v9H3V6a1 1 0 011-1zm-2 13h20",
  couch:
    "M5 11V8a3 3 0 013-3h8a3 3 0 013 3v3M3 11a2 2 0 012 2v4h14v-4a2 2 0 012-2M3 11h18M5 17v2m14-2v2",
  shirt: "M9 4L3 7l2 4 2-1v11h10V10l2 1 2-4-6-3a3 3 0 01-6 0z",
  gem: "M6 3h12l4 6-10 12L2 9l4-6zm0 0l4 6 2-6 2 6 4-6M2 9h20M12 21L8 9m4 12l4-12",
  pencil: "M12 20h9M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4L16.5 3.5z",
  heart:
    "M12 21s-7-4.5-9.5-9A5.5 5.5 0 0112 6a5.5 5.5 0 019.5 6c-2.5 4.5-9.5 9-9.5 9z",
  sparkles:
    "M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3zm7 11l.9 2.1L22 17l-2.1.9L19 20l-.9-2.1L16 17l2.1-.9L19 14z",
  hands:
    "M12 12a4 4 0 100-8 4 4 0 000 8zm-7 9a7 7 0 0114 0H5zm-2-9a2 2 0 012-2m14 0a2 2 0 00-2-2",
  gamepad:
    "M6 9h12a5 5 0 015 5c0 2.5-2 4-4 4-1.2 0-2.3-.7-2.8-1.7L14.5 14h-5l-1.7 2.3c-.5 1-1.6 1.7-2.8 1.7-2 0-4-1.5-4-4a5 5 0 015-5zM7 12v3m-1.5-1.5h3m8-1.5h.01m2 0h.01",
  coffee:
    "M4 8h13v7a4 4 0 01-4 4H8a4 4 0 01-4-4V8zm13 1h2a2 2 0 010 4h-2M7 4c0 1-1 1-1 2m4-2c0 1-1 1-1 2",
  calendar:
    "M8 2v4m8-4v4M3 8h18M5 4h14a2 2 0 012 2v14a2 2 0 01-2 2H5a2 2 0 01-2-2V6a2 2 0 012-2zm3 12l2 2 4-4",
  rocket:
    "M5 15c-1.5 1.5-2 5-2 5s3.5-.5 5-2M9 11l6 6m2-9c1-4-1-6-5-5-2.5.6-4 2-5 4l7 7c2-1 3.4-2.5 4-5 1-4-1-6-5-5-1 0-2 .5-2 .5",
  palette:
    "M12 3a9 9 0 100 18c1.5 0 2-1 1.3-2.2-.7-1.2 0-2.8 1.7-2.8H17a4 4 0 004-4c0-5-4-9-9-9zm-5 9h.01M8.5 16h.01m3.5-9h.01m3 3h.01",
  card: "M3 7h18a1 1 0 011 1v8a1 1 0 01-1 1H3a1 1 0 01-1-1V8a1 1 0 011-1zm1 4h5",
  check: "M5 13l4 4L19 7",
  play: "M14.5 12a.5.5 0 010 1M21 12a9 9 0 11-18 0 9 9 0 0118 0zm-9-2v5l4-2.5-4-2.5z",
  star: "M12 2l3.1 6.3 6.9 1-5 4.9 1.2 6.8L12 17.8 5.8 21l1.2-6.8-5-4.9 6.9-1L12 2z",
  shield:
    "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6l8-3zm-3 9l2 2 4-4",
  chevron: "M6 9l6 6 6-6",
  arrowLeft: "M19 12H5m6-6l-6 6 6 6",
  lock: "M7 11V7a5 5 0 0110 0v4m-11 0h12a1 1 0 011 1v8a1 1 0 01-1 1H6a1 1 0 01-1-1v-8a1 1 0 011-1z",
  mobile: "M8 2h8a1 1 0 011 1v18a1 1 0 01-1 1H8a1 1 0 01-1-1V3a1 1 0 011-1zm3 17h2",
  bank: "M3 9l9-6 9 6M4 9v10m4-10v10m4-10v10m4-10v10m4-10v10M2 21h20",
};

/* ---------- data ---------- */

const SECTORS = [
  { icon: PATHS.store, title: "متاجر سلة في القطاعات", desc: "خُذ جولة على متاجر في قطاعات مختلفة" },
  { icon: PATHS.laptop, title: "الإلكترونيات", desc: "أسهل تجربة لبيع الإلكترونيات" },
  { icon: PATHS.couch, title: "مستلزمات المنزل", desc: "تجربة مريحة لك ولعميلك" },
  { icon: PATHS.shirt, title: "عبايات وأزياء", desc: "تجارة أنيقة بدون تعقيد" },
  { icon: PATHS.gem, title: "المجوهرات", desc: "مزايا متعددة تُبرز تميُّز مجوهراتك" },
  { icon: PATHS.pencil, title: "تصميم الخدمات", desc: "تسليم فوري لمنتجاتك" },
  { icon: PATHS.heart, title: "الصحة واللياقة", desc: "قدِّم منتجاتك بصورة مقنعة لعميلك" },
  { icon: PATHS.sparkles, title: "العناية والتجميل", desc: "مع سلة تفهم عميلك الباحث عن الجمال" },
  { icon: PATHS.hands, title: "الجمعيات الخيرية", desc: "سهِّل عمل الخير وأنت في أهلك" },
  { icon: PATHS.gamepad, title: "المنتجات الرقمية", desc: "تاجر بمنتجات رقمية دون صعوبات تقنية" },
  { icon: PATHS.coffee, title: "المطاعم والمقاهي", desc: "حلول مخصصة لبيع المأكولات والمشروبات" },
  { icon: PATHS.calendar, title: "العبادات", desc: "حجز مواعيد تلقائي بدون إدخال يدوي" },
];

type TabId = "launch" | "design" | "payments";

const TABS: {
  id: TabId;
  label: string;
  icon: string;
  badge: string;
  heading: string;
  text: string;
  bullets: string[];
}[] = [
  {
    id: "launch",
    label: "الإنشاء والتدشين",
    icon: PATHS.rocket,
    badge: "إنشاء وتدشين المتجر",
    heading: "انطلاقتك سهلة حتى بانشغالك",
    text: "لا تحتاج لخبرة سابقة أو تفرُّغ تام لتبدأ تجارتك مع سلة.",
    bullets: [
      "+1000 خدمة من مزوِّدي خدمات التاجر تقدِّم لك كل ما تحتاجه.",
      "خطوات سهلة وسريعة لإنشاء متجرك.",
      "تبادل التجارب والخبرات مع آلاف التجار في مجتمع تجار سلة سوريا.",
    ],
  },
  {
    id: "design",
    label: "تصميم المتجر",
    icon: PATHS.palette,
    badge: "تصميم المتجر",
    heading: "متجر يلفت النظر من أول لمحة",
    text: "تميَّز في السوق وامنح عملاءك تجربة لا تُنسى.",
    bullets: [
      "مكتبة متنوعة من الثيمات الجاهزة القابلة للتخصيص حسب رغبتك.",
      "تخصيص تفاصيل التصميم عن طريق JS و CSS.",
      "يمكنك صنع ثيمك الخاص مع Salla Twilight.",
    ],
  },
  {
    id: "payments",
    label: "المدفوعات",
    icon: PATHS.card,
    badge: "المدفوعات",
    heading: "مدفوعات آمنة، لتجارة مستدامة، وثقة متينة!",
    text: "استفد من نظام سلة المتكامل للمدفوعات الإلكترونية لإدارة مدفوعات متجرك وعملائك.",
    bullets: [
      "وسائل دفع متنوعة تلبي كافة احتياجات عملائك.",
      "تفعيل سريع لنظام المدفوعات خلال يوم واحد.",
      "تحصيل المدفوعات بعد 24 ساعة.",
      "حماية عالية وأمان لكافة عملياتك.",
    ],
  },
];

const FOOTER_COLS: { heading: string; links: string[] }[] = [
  {
    heading: "عن سلة",
    links: ["انضم لفريق سلة", "اتفاقية الاستخدام", "اتفاقية التسويق بالعمولة", "سياسة الخصوصية", "منصة الشكاوى"],
  },
  {
    heading: "شركاء سلة",
    links: ["انضم كشريك", "برامج الشركاء", "مجتمع الشركاء", "موارد الشركاء", "انضم كمسوِّق بالعمولة"],
  },
  {
    heading: "الموارد",
    links: ["مركز المساعدة", "أكاديمية سلة", "مجتمع سلة", "مدونة سلة", "أخبار سلة"],
  },
  {
    heading: "الحلول",
    links: ["متجر التطبيقات", "صانع التطبيقات", "المتاجر الجاهزة", "أدوات التسويق", "التسويق مع المؤثرين", "المدفوعات", "سلة 4.0", "متجر الثيمات"],
  },
  {
    heading: "القطاعات",
    links: ["عبايات وأزياء", "المنتجات الرقمية", "الصحة والرياضة", "الإلكترونيات", "المجوهرات", "العناية والتجميل", "المطاعم والمقاهي", "مستلزمات المنزل"],
  },
];

/* ---------- page ---------- */

export default function HomePage() {
  const [activeTab, setActiveTab] = useState<TabId>("launch");
  const tab = TABS.find((t) => t.id === activeTab)!;

  return (
    <div className="min-h-screen bg-white">
      <Navbar />

      {/* ===== HERO ===== */}
      <section className="relative overflow-hidden bg-gradient-to-b from-[#E8F5E9] via-white to-white pt-16">
        <div className="pointer-events-none absolute inset-0" aria-hidden="true">
          <div className="absolute -top-24 -left-24 h-96 w-96 rounded-full bg-[#E8F5E9] blur-3xl" />
          <div className="absolute top-40 -right-24 h-80 w-80 rounded-full bg-[#E8F5E9]/70 blur-3xl" />
          <div className="absolute bottom-0 left-1/3 h-64 w-64 rounded-full bg-[#2E7D32]/5 blur-3xl" />
        </div>

        <Container className="relative py-16 text-center sm:py-20 lg:py-24">
          <span className="inline-flex items-center gap-2 rounded-full border border-[#2E7D32]/20 bg-white px-4 py-1.5 text-sm font-semibold text-[#2E7D32] shadow-sm">
            <Icon d={PATHS.star} className="h-4 w-4" />
            أكبر منصَّة سورية للتجارة الإلكترونية
          </span>

          <h1 className="mx-auto mt-6 max-w-3xl text-4xl font-black leading-tight text-gray-900 sm:text-5xl lg:text-6xl">
            أطلِق متجرك الإلكتروني
            <span className="text-[#2E7D32]"> في دقائق</span>
          </h1>

          <p className="mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-gray-600">
            أنتَ تمتلك الرؤية، نحن نساعدك على بنائها.
            <br />
            أنشئ متجرك، اقبل المدفوعات، أدِر الشحن، وتحكَّم في كل شيء من مكانٍ واحد.
          </p>

          <p className="mx-auto mt-4 max-w-2xl text-base text-gray-500">
            أنشئ متجرك اليوم وانضمَّ لعشرات الآلاف من الأفراد والمؤسسات والشركات الناجحة مع سلة
          </p>

          <div className="mt-8 flex flex-col items-center justify-center gap-4 sm:flex-row">
            <Link href="/auth/register">
              <Button variant="primary" size="lg" className="rounded-xl">
                <Icon d={PATHS.rocket} className="h-5 w-5" />
                ابدأ مجاناً الآن
              </Button>
            </Link>
            <Link href="#features">
              <Button variant="ghost" size="lg" className="rounded-xl border border-gray-200">
                <Icon d={PATHS.play} className="h-5 w-5" />
                اكتشف المميزات
              </Button>
            </Link>
          </div>

          <div className="mt-12 flex items-center justify-center gap-6 sm:gap-10">
            <div className="text-center">
              <div className="text-2xl font-black text-gray-900 sm:text-3xl">+50,000</div>
              <div className="mt-1 text-sm text-gray-500">متجر نشط</div>
            </div>
            <div className="h-12 w-px bg-gray-200" aria-hidden="true" />
            <div className="text-center">
              <div className="text-2xl font-black text-gray-900 sm:text-3xl">+1,000</div>
              <div className="mt-1 text-sm text-gray-500">خدمة متاحة</div>
            </div>
            <div className="h-12 w-px bg-gray-200" aria-hidden="true" />
            <div className="text-center">
              <div className="text-2xl font-black text-gray-900 sm:text-3xl">24/7</div>
              <div className="mt-1 text-sm text-gray-500">دعم فني</div>
            </div>
          </div>

          <a
            href="#sectors"
            className="mt-10 inline-flex text-gray-400 transition-colors hover:text-[#2E7D32]"
            aria-label="انتقل إلى القطاعات"
          >
            <Icon d={PATHS.chevron} className="h-6 w-6 animate-bounce" />
          </a>
        </Container>
      </section>

      {/* ===== SECTORS ===== */}
      <section id="sectors" className="scroll-mt-20 bg-gray-50/60 py-16 sm:py-20">
        <Container>
          <div className="mx-auto max-w-2xl text-center">
            <span className="inline-block rounded-full bg-[#E8F5E9] px-4 py-1 text-sm font-bold text-[#2E7D32]">
              القطاعات
            </span>
            <h2 className="mt-4 text-3xl font-black text-gray-900 sm:text-4xl">
              متاجر سلة في القطاعات
            </h2>
            <p className="mt-3 text-gray-600">
              خُذ جولة في متاجر في قطاعات مختلفة وابدأ رحلتك التجارية
            </p>
          </div>

          <div className="mt-10 grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
            {SECTORS.map((s) => (
              <Card
                key={s.title}
                variant="bordered"
                className="group transition-all hover:-translate-y-1 hover:border-[#2E7D32]/30 hover:shadow-lg"
              >
                <span className="flex h-12 w-12 items-center justify-center rounded-xl bg-[#E8F5E9] text-[#2E7D32] transition-colors group-hover:bg-[#2E7D32] group-hover:text-white">
                  <Icon d={s.icon} className="h-6 w-6" />
                </span>
                <h3 className="mt-4 text-lg font-bold text-gray-900">{s.title}</h3>
                <p className="mt-1 text-sm leading-relaxed text-gray-600">{s.desc}</p>
              </Card>
            ))}
          </div>
        </Container>
      </section>

      {/* ===== FASHION FEATURE ===== */}
      <section id="fashion" className="scroll-mt-20 py-16 sm:py-20">
        <Container>
          <div className="grid items-center gap-10 lg:grid-cols-2">
            <div>
              <span className="inline-block rounded-full bg-[#E8F5E9] px-4 py-1 text-sm font-bold text-[#2E7D32]">
                عبايات وأزياء
              </span>
              <h2 className="mt-4 text-3xl font-black text-gray-900 sm:text-4xl">
                حيث تلتقي السهولة بالأناقة
              </h2>
              <p className="mt-4 leading-relaxed text-gray-600">
                حقِّق نمو علامتك التجارية في سوق الأزياء والعبايات مع حلول نُسجت بعناية
                لتسهِّل إدارة متجرك وتقدِّم تجربة تسوُّق استثنائية لعملائك.
              </p>
              <ul className="mt-6 space-y-3">
                {[
                  "استبق سؤال العميل عبر جدول المقاسات",
                  "قدِّم تجربة شراء سهلة ومألوفة لكل عميل",
                  "اعرض صور ثلاثية الأبعاد تُبرز أناقة التفاصيل",
                ].map((b) => (
                  <li key={b} className="flex items-center gap-3 text-gray-700">
                    <Icon d={PATHS.check} className="h-5 w-5 shrink-0 text-[#2E7D32]" />
                    {b}
                  </li>
                ))}
              </ul>
              <Link href="/auth/register" className="mt-8 inline-block">
                <Button variant="primary" size="md" className="rounded-xl">
                  اكتشف المزيد
                  <Icon d={PATHS.arrowLeft} className="h-5 w-5" />
                </Button>
              </Link>
            </div>

            <div className="relative mx-auto flex h-80 w-full max-w-md items-center justify-center" aria-hidden="true">
              <div className="absolute h-64 w-56 rotate-6 rounded-3xl bg-[#E8F5E9]" />
              <div className="absolute h-64 w-56 -rotate-3 rounded-3xl bg-[#2E7D32]/10" />
              <div className="relative flex h-64 w-56 flex-col items-center justify-center gap-3 rounded-3xl bg-[#2E7D32] text-white shadow-2xl">
                <Icon d={PATHS.shirt} className="h-16 w-16" />
                <span className="text-lg font-bold">متجر الأزياء</span>
              </div>
            </div>
          </div>
        </Container>
      </section>

      {/* ===== FEATURES TABS ===== */}
      <section id="features" className="scroll-mt-20 bg-gray-50/60 py-16 sm:py-20">
        <Container>
          <div className="mx-auto max-w-2xl text-center">
            <span className="inline-block rounded-full bg-[#E8F5E9] px-4 py-1 text-sm font-bold text-[#2E7D32]">
              المميزات
            </span>
            <h2 className="mt-4 text-3xl font-black text-gray-900 sm:text-4xl">
              كل ما تحتاجه في مكانٍ واحد
            </h2>
          </div>

          <div className="mx-auto mt-8 flex max-w-2xl flex-col gap-3 sm:flex-row sm:justify-center" role="tablist" aria-label="مميزات سلة سوريا">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={activeTab === t.id}
                onClick={() => setActiveTab(t.id)}
                className={`flex items-center justify-center gap-2 rounded-xl px-6 py-3 font-bold transition-colors ${
                  activeTab === t.id
                    ? "bg-[#2E7D32] text-white shadow-md"
                    : "bg-white text-gray-600 ring-1 ring-gray-200 hover:text-[#2E7D32] hover:ring-[#2E7D32]/30"
                }`}
              >
                <Icon d={t.icon} className="h-5 w-5" />
                {t.label}
              </button>
            ))}
          </div>

          <Card variant="elevated" className="mx-auto mt-8 max-w-5xl" padding="lg">
            <div className="grid items-center gap-8 md:grid-cols-2">
              <div>
                <span className="inline-flex items-center gap-2 rounded-full bg-[#E8F5E9] px-3 py-1 text-sm font-bold text-[#2E7D32]">
                  <Icon d={tab.icon} className="h-4 w-4" />
                  {tab.badge}
                </span>
                <h3 className="mt-4 text-2xl font-black text-gray-900">{tab.heading}</h3>
                <p className="mt-2 text-gray-600">{tab.text}</p>
                <ul className="mt-5 space-y-3">
                  {tab.bullets.map((b) => (
                    <li key={b} className="flex items-start gap-3 text-gray-700">
                      <Icon d={PATHS.check} className="mt-0.5 h-5 w-5 shrink-0 text-[#2E7D32]" />
                      {b}
                    </li>
                  ))}
                </ul>
              </div>

              <div className="rounded-2xl border border-gray-200 bg-gray-50 p-4" aria-hidden="true">
                <div className="flex gap-1.5" aria-hidden="true">
                  <span className="h-2.5 w-2.5 rounded-full bg-red-300" />
                  <span className="h-2.5 w-2.5 rounded-full bg-yellow-300" />
                  <span className="h-2.5 w-2.5 rounded-full bg-green-300" />
                </div>
                {activeTab === "launch" && (
                  <div className="mt-4 space-y-2">
                    {["إنشاء الحساب", "تخصيص المتجر"].map((s) => (
                      <div key={s} className="flex items-center gap-2 rounded-lg bg-white px-3 py-2 text-sm text-gray-600 ring-1 ring-gray-100">
                        <span className="flex h-5 w-5 items-center justify-center rounded-full bg-[#2E7D32] text-white">
                          <Icon d={PATHS.check} className="h-3 w-3" />
                        </span>
                        {s}
                      </div>
                    ))}
                    <div className="flex items-center gap-2 rounded-lg bg-[#2E7D32] px-3 py-2 text-sm font-bold text-white">
                      <Icon d={PATHS.rocket} className="h-4 w-4" />
                      التدشين!
                    </div>
                  </div>
                )}
                {activeTab === "design" && (
                  <div className="mt-4 grid grid-cols-2 gap-2">
                    <div className="h-20 rounded-lg bg-[#2E7D32]/80" />
                    <div className="h-20 rounded-lg bg-[#E8F5E9]" />
                    <div className="h-20 rounded-lg bg-gray-800" />
                    <div className="h-20 rounded-lg bg-[#2E7D32]/30" />
                  </div>
                )}
                {activeTab === "payments" && (
                  <div className="mt-4 space-y-2" id="payments">
                    {[
                      { icon: PATHS.card, label: "بطاقة ائتمان" },
                      { icon: PATHS.mobile, label: "دفع إلكتروني" },
                      { icon: PATHS.bank, label: "تحويل بنكي" },
                    ].map((m) => (
                      <div key={m.label} className="flex items-center gap-2 rounded-lg bg-white px-3 py-2 text-sm text-gray-700 ring-1 ring-gray-100">
                        <Icon d={m.icon} className="h-4 w-4 text-[#2E7D32]" />
                        {m.label}
                      </div>
                    ))}
                    <div className="flex items-center justify-center gap-2 rounded-lg bg-[#E8F5E9] px-3 py-2 text-sm font-bold text-[#2E7D32]">
                      <Icon d={PATHS.lock} className="h-4 w-4" />
                      محمي ومشفَّر
                    </div>
                  </div>
                )}
              </div>
            </div>
          </Card>
        </Container>
      </section>

      {/* ===== CTA BANNER ===== */}
      <section className="relative overflow-hidden bg-[#2E7D32] py-16">
        <div className="pointer-events-none absolute inset-0" aria-hidden="true">
          <div className="absolute -top-20 -right-20 h-72 w-72 rounded-full bg-white/10 blur-2xl" />
          <div className="absolute -bottom-24 -left-16 h-72 w-72 rounded-full bg-black/10 blur-2xl" />
        </div>
        <Container className="relative text-center text-white">
          <h2 className="text-3xl font-black sm:text-4xl">ابدأ رحلتك التجارية اليوم</h2>
          <p className="mt-3 text-white/85">انضم لعشرات الآلاف من التجار الناجحين على سلة سوريا</p>
          <Link href="/auth/register" className="mt-8 inline-block">
            <Button variant="white" size="lg" className="rounded-xl">
              <Icon d={PATHS.store} className="h-5 w-5" />
              أنشئ متجرك الآن — مجاناً
            </Button>
          </Link>
        </Container>
      </section>

      {/* ===== FOOTER ===== */}
      <footer id="about" className="scroll-mt-20 bg-gray-900 py-14 text-gray-300">
        <Container>
          <div className="grid gap-10 md:grid-cols-2 lg:grid-cols-6">
            <div className="lg:col-span-1">
              <span className="flex items-center gap-2 text-white">
                <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-white/10 text-white">
                  <Icon d={PATHS.store} className="h-6 w-6" />
                </span>
                <span className="text-xl font-bold">
                  سلة <span className="font-normal text-gray-400">سوريا</span>
                </span>
              </span>
              <p className="mt-4 text-sm leading-relaxed text-gray-400">
                أكبر منصَّة سورية للتجارة الإلكترونية في سوريا.
              </p>
            </div>

            {FOOTER_COLS.map((col) => (
              <div key={col.heading} id={col.heading === "شركاء سلة" ? "partners" : undefined}>
                <h4 className="font-bold text-white">{col.heading}</h4>
                <ul className="mt-4 space-y-2.5 text-sm">
                  {col.links.map((l) => (
                    <li key={l}>
                      <a href="#" className="text-gray-400 transition-colors hover:text-white">
                        {l}
                      </a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>

          <div className="mt-12 border-t border-white/10 pt-6 text-center text-sm text-gray-400">
            <p>
              © 2025 سلة سوريا —{" "}
              <a href="https://sallasyria.com" className="text-gray-300 hover:text-white">
                sallasyria.com
              </a>{" "}
              — جميع الحقوق محفوظة
            </p>
          </div>
        </Container>
      </footer>
    </div>
  );
}
