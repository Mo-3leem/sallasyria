"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Navbar } from "@/components/Navbar";

/* ================= data (from reference/index.html) ================= */

const SECTORS = [
  { icon: "fas fa-store", title: "متاجر سلة في القطاعات", desc: "خُذ جولة على متاجر في قطاعات مختلفة" },
  { icon: "fas fa-laptop", title: "الإلكترونيات", desc: "أسهل تجربة لبيع الإلكترونيات" },
  { icon: "fas fa-couch", title: "مستلزمات المنزل", desc: "تجربة مريحة لك ولعميلك" },
  { icon: "fas fa-tshirt", title: "عبايات وأزياء", desc: "تجارة أنيقة بدون تعقيد" },
  { icon: "fas fa-gem", title: "المجوهرات", desc: "مزايا متعددة تُبرز تميُّز مجوهراتك" },
  { icon: "fas fa-pencil-alt", title: "تصميم الخدمات", desc: "تسليم فوري لمنتجاتك" },
  { icon: "fas fa-heartbeat", title: "الصحة واللياقة", desc: "قدِّم منتجاتك بصورة مقنعة لعميلك" },
  { icon: "fas fa-spa", title: "العناية والتجميل", desc: "مع سلة تفهم عميلك الباحث عن الجمال" },
  { icon: "fas fa-hands-helping", title: "الجمعيات الخيرية", desc: "سهِّل عمل الخير وأنت في أهلك" },
  { icon: "fas fa-gamepad", title: "المنتجات الرقمية", desc: "تاجر بمنتجات رقمية دون صعوبات تقنية" },
  { icon: "fas fa-coffee", title: "المطاعم والمقاهي", desc: "حلول فخصصة لبيع المأكولات والمشروبات" },
  { icon: "fas fa-calendar-check", title: "العبادات", desc: "حجز مواعيد تلقائي بدون إدخال يدوي" },
];

const FASHION_BULLETS = [
  "استبق سؤال العميل عبر جدول المقاسات",
  "قدِّم تجربة شراء سهلة ومألوفة لكل عميل",
  "اعرض صور ثلاثية الأبعاد تُبرز أناقة التفاصيل",
];

type TabId = "launch" | "design" | "payments";

const TABS: {
  id: TabId;
  label: string;
  icon: string;
  badge: string;
  badgeIcon: string;
  heading: string;
  text: string;
  bullets: string[];
}[] = [
  {
    id: "launch",
    label: "الإنشاء والتدشين",
    icon: "fas fa-rocket",
    badge: "إنشاء وتدشين المتجر",
    badgeIcon: "fas fa-rocket",
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
    icon: "fas fa-palette",
    badge: "تصميم المتجر",
    badgeIcon: "fas fa-palette",
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
    icon: "fas fa-credit-card",
    badge: "المدفوعات",
    badgeIcon: "fas fa-shield-alt",
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

const FOOTER_COLS: { id?: string; heading: string; links: string[] }[] = [
  {
    id: "about-col",
    heading: "عن سلة",
    links: ["انضم لفريق سلة", "اتفاقية الاستخدام", "اتفاقية التسويق بالعمولة", "سياسة الخصوصية", "منصة الشكاوى"],
  },
  {
    id: "partners",
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

const SOCIALS = [
  { icon: "fab fa-twitter", label: "تويتر" },
  { icon: "fab fa-instagram", label: "انستغرام" },
  { icon: "fab fa-youtube", label: "يوتيوب" },
  { icon: "fab fa-linkedin", label: "لينكد إن" },
];

/* ================= page ================= */

export default function HomePage() {
  const [activeTab, setActiveTab] = useState<TabId>("launch");
  const [showScrollTop, setShowScrollTop] = useState(false);
  const statsRef = useRef<HTMLDivElement>(null);
  const countersDone = useRef(false);

  const active = TABS.find((t) => t.id === activeTab)!;

  // 3. IntersectionObserver — AOS reveal (reference main.js §3)
  useEffect(() => {
    const els = document.querySelectorAll("[data-aos]");
    const observer = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            entry.target.classList.add("aos-animate");
            observer.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.1, rootMargin: "0px 0px -50px 0px" }
    );
    els.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, []);

  // 4. Counter animation for hero stats (reference main.js §4)
  useEffect(() => {
    const statsSection = statsRef.current;
    if (!statsSection) return;

    const parseNum = (str: string) => parseInt(str.replace(/[^0-9]/g, ""), 10) || 0;
    const formatNum = (original: string, current: number) => {
      if (original.includes("+")) return "+" + current.toLocaleString("ar");
      if (original.includes("/")) return original;
      return current.toLocaleString("ar");
    };
    const animateCounter = (el: Element) => {
      const target = el as HTMLElement;
      const original = (target.textContent ?? "").trim();
      if (original.includes("/")) return;
      const end = parseNum(original);
      if (!end) return;
      target.classList.add("counting");
      let start = 0;
      const duration = 1800;
      const step = (timestamp: number) => {
        if (!start) start = timestamp;
        const progress = Math.min((timestamp - start) / duration, 1);
        const eased = 1 - Math.pow(1 - progress, 3);
        target.textContent = formatNum(original, Math.floor(eased * end));
        if (progress < 1) requestAnimationFrame(step);
        else {
          target.textContent = original;
          target.classList.remove("counting");
        }
      };
      requestAnimationFrame(step);
    };

    const statsObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting && !countersDone.current) {
            countersDone.current = true;
            entry.target.querySelectorAll(".stat-num").forEach(animateCounter);
            statsObserver.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.5 }
    );
    statsObserver.observe(statsSection);
    return () => statsObserver.disconnect();
  }, []);

  // 7. Scroll-to-top visibility (reference main.js §7)
  useEffect(() => {
    const onScroll = () => setShowScrollTop(window.scrollY > 400);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  // 6. Sector-card ripple (reference main.js §6)
  const handleSectorClick = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const card = e.currentTarget;
    const rect = card.getBoundingClientRect();
    const ripple = document.createElement("span");
    ripple.className = "sector-ripple";
    ripple.style.left = `${e.clientX - rect.left - 50}px`;
    ripple.style.top = `${e.clientY - rect.top - 50}px`;
    card.appendChild(ripple);
    window.setTimeout(() => ripple.remove(), 600);
  }, []);

  return (
    <>
      <Navbar />

      {/* ===== HERO ===== */}
      <section className="hero">
        <div className="hero-bg-shapes" aria-hidden="true">
          <div className="shape shape-1"></div>
          <div className="shape shape-2"></div>
          <div className="shape shape-3"></div>
        </div>
        <div className="container hero-content">
          <div className="hero-badge">
            <i className="fas fa-star" aria-hidden="true"></i>
            <span>أكبر منصَّة سورية للتجارة الإلكترونية</span>
          </div>
          <h1 className="hero-title">
            أطلِق متجرك الإلكتروني <span className="hero-highlight">في دقائق</span>
          </h1>
          <p className="hero-sub">
            أنتَ تمتلك الرؤية، نحن نساعدك على بنائها.
            <br />
            أنشئ متجرك، اقبل المدفوعات، أدِر الشحن، وتحكَّم في كل شيء من مكانٍ واحد.
          </p>
          <div className="hero-arabic">
            أنشئ متجرك اليوم وانضمَّ لعشرات الآلاف من الأفراد والمؤسسات والشركات الناجحة مع سلة
          </div>
          <div className="hero-ctas">
            <a href="/auth/register" className="btn btn-primary btn-lg">
              <i className="fas fa-rocket" aria-hidden="true"></i>
              ابدأ مجاناً الآن
            </a>
            <a href="#features" className="btn btn-ghost btn-lg">
              <i className="fas fa-play-circle" aria-hidden="true"></i>
              اكتشف المميزات
            </a>
          </div>
          <div className="hero-stats" ref={statsRef}>
            <div className="stat-item">
              <span className="stat-num">+50,000</span>
              <span className="stat-label">متجر نشط</span>
            </div>
            <div className="stat-divider"></div>
            <div className="stat-item">
              <span className="stat-num">+1,000</span>
              <span className="stat-label">خدمة متاحة</span>
            </div>
            <div className="stat-divider"></div>
            <div className="stat-item">
              <span className="stat-num">24/7</span>
              <span className="stat-label">دعم فني</span>
            </div>
          </div>
        </div>
        <div className="hero-scroll">
          <a href="#sectors" aria-label="انتقل إلى القطاعات">
            <i className="fas fa-chevron-down" aria-hidden="true"></i>
          </a>
        </div>
      </section>

      {/* ===== SECTORS ===== */}
      <section className="sectors" id="sectors">
        <div className="container">
          <div className="section-header">
            <span className="section-tag">القطاعات</span>
            <h2 className="section-title">متاجر سلة في القطاعات</h2>
            <p className="section-desc">خُذ جولة في متاجر في قطاعات مختلفة وابدأ رحلتك التجارية</p>
          </div>

          <div className="sectors-grid">
            {SECTORS.map((sector) => (
              <div
                key={sector.title}
                className="sector-card"
                data-aos="fade-up"
                onClick={handleSectorClick}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") e.currentTarget.click();
                }}
              >
                <div className="sector-icon-wrap">
                  <i className={sector.icon} aria-hidden="true"></i>
                </div>
                <div className="sector-info">
                  <h3>{sector.title}</h3>
                  <p>{sector.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ===== FASHION FEATURE ===== */}
      <section className="fashion-feature" id="fashion">
        <div className="container">
          <div className="fashion-inner">
            <div className="fashion-text">
              <div className="section-tag">عبايات وأزياء</div>
              <h2>حيث تلتقي السهولة بالأناقة</h2>
              <p>
                حقِّق نمو علامتك التجارية في سوق الأزياء والعبايات مع حلول نُسجت بعناية
                لتسهِّل إدارة متجرك وتقدِّم تجربة تسوُّق استثنائية لعملائك.
              </p>
              <ul className="feature-bullets">
                {FASHION_BULLETS.map((bullet) => (
                  <li key={bullet}>
                    <span className="bullet-icon">
                      <i className="fas fa-check-circle" aria-hidden="true"></i>
                    </span>
                    {bullet}
                  </li>
                ))}
              </ul>
              <a href="#" className="btn btn-primary">
                اكتشف المزيد <i className="fas fa-arrow-left" aria-hidden="true"></i>
              </a>
            </div>
            <div className="fashion-visual" aria-hidden="true">
              <div className="fashion-card-stack">
                <div className="fcard fcard-bg"></div>
                <div className="fcard fcard-mid"></div>
                <div className="fcard fcard-front">
                  <i className="fas fa-tshirt fa-5x" aria-hidden="true"></i>
                  <span>متجر الأزياء</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ===== FEATURES TABS ===== */}
      <section className="features" id="features">
        <div className="container">
          <div className="section-header">
            <span className="section-tag">المميزات</span>
            <h2 className="section-title">كل ما تحتاجه في مكانٍ واحد</h2>
          </div>

          <div className="tabs-wrapper">
            <div className="tabs-nav" role="tablist" aria-label="مميزات سلة سوريا">
              {TABS.map((tab) => (
                <button
                  key={tab.id}
                  className={`tab-btn${activeTab === tab.id ? " active" : ""}`}
                  role="tab"
                  aria-selected={activeTab === tab.id}
                  onClick={() => setActiveTab(tab.id)}
                >
                  <i className={tab.icon} aria-hidden="true"></i>
                  <span>{tab.label}</span>
                </button>
              ))}
            </div>

            <div className="tabs-content">
              {/* Key re-triggers the fadeInUp entrance like the reference reflow trick */}
              <div key={active.id} className="tab-panel active" style={{ animation: "fadeInUp .4s ease both" }}>
                <div className="tab-panel-inner">
                  <div className="tab-text">
                    <div className="tab-badge">
                      <i className={active.badgeIcon} aria-hidden="true"></i> {active.badge}
                    </div>
                    <h3>{active.heading}</h3>
                    <p>{active.text}</p>
                    <ul className="feature-bullets">
                      {active.bullets.map((bullet) => (
                        <li key={bullet}>
                          <span className="bullet-icon">
                            <i className="fas fa-check-circle" aria-hidden="true"></i>
                          </span>
                          {bullet}
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div className="tab-visual" aria-hidden="true">
                    {active.id === "launch" && (
                      <div className="visual-mockup launch-mockup">
                        <div className="mockup-header">
                          <span></span>
                          <span></span>
                          <span></span>
                        </div>
                        <div className="mockup-body">
                          <div className="mockup-step done">
                            <i className="fas fa-check" aria-hidden="true"></i> إنشاء الحساب
                          </div>
                          <div className="mockup-step done">
                            <i className="fas fa-check" aria-hidden="true"></i> تخصيص المتجر
                          </div>
                          <div className="mockup-step active">
                            <i className="fas fa-rocket" aria-hidden="true"></i> التدشين!
                          </div>
                        </div>
                      </div>
                    )}
                    {active.id === "design" && (
                      <div className="visual-mockup design-mockup">
                        <div className="mockup-header">
                          <span></span>
                          <span></span>
                          <span></span>
                        </div>
                        <div className="mockup-body design-body">
                          <div className="theme-grid">
                            <div className="theme-box t1"></div>
                            <div className="theme-box t2"></div>
                            <div className="theme-box t3"></div>
                            <div className="theme-box t4"></div>
                          </div>
                        </div>
                      </div>
                    )}
                    {active.id === "payments" && (
                      <div className="visual-mockup payments-mockup" id="payments">
                        <div className="mockup-header">
                          <span></span>
                          <span></span>
                          <span></span>
                        </div>
                        <div className="mockup-body pay-body">
                          <div className="pay-methods">
                            <div className="pay-method">
                              <i className="fas fa-credit-card" aria-hidden="true"></i> بطاقة ائتمان
                            </div>
                            <div className="pay-method">
                              <i className="fas fa-mobile-alt" aria-hidden="true"></i> دفع إلكتروني
                            </div>
                            <div className="pay-method">
                              <i className="fas fa-university" aria-hidden="true"></i> تحويل بنكي
                            </div>
                          </div>
                          <div className="pay-secure">
                            <i className="fas fa-lock" aria-hidden="true"></i> محمي ومشفَّر
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ===== CTA BANNER ===== */}
      <section className="cta-banner">
        <div className="cta-shapes" aria-hidden="true">
          <div className="cta-shape cta-shape-1"></div>
          <div className="cta-shape cta-shape-2"></div>
        </div>
        <div className="container cta-content">
          <h2>ابدأ رحلتك التجارية اليوم</h2>
          <p>انضم لعشرات الآلاف من التجار الناجحين على سلة سوريا</p>
          <a href="/auth/register" className="btn btn-white btn-lg">
            <i className="fas fa-store" aria-hidden="true"></i>
            أنشئ متجرك الآن — مجاناً
          </a>
        </div>
      </section>

      {/* ===== FOOTER ===== */}
      <footer className="footer" id="about">
        <div className="container">
          <div className="footer-top">
            <div className="footer-brand">
              <a href="#" className="logo logo-light" aria-label="سلة سوريا">
                <span className="logo-icon">
                  <i className="fas fa-shopping-bag" aria-hidden="true"></i>
                </span>
                <span className="logo-text">
                  سلة <span className="logo-sub">سوريا</span>
                </span>
              </a>
              <p>أكبر منصَّة سورية للتجارة الإلكترونية في سوريا.</p>
              <div className="social-links">
                {SOCIALS.map((social) => (
                  <a key={social.label} href="#" aria-label={social.label}>
                    <i className={social.icon} aria-hidden="true"></i>
                  </a>
                ))}
              </div>
            </div>

            {FOOTER_COLS.map((col) => (
              <div key={col.heading} className="footer-col" id={col.id}>
                <h4>{col.heading}</h4>
                <ul>
                  {col.links.map((link) => (
                    <li key={link}>
                      <a href="#">{link}</a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>

          <div className="footer-bottom">
            <p>
              © 2025 سلة سوريا — <a href="https://sallasyria.com">sallasyria.com</a> — جميع الحقوق محفوظة
            </p>
          </div>
        </div>
      </footer>

      {/* ===== SCROLL TO TOP (reference main.js §7) ===== */}
      {showScrollTop && (
        <button
          type="button"
          className="scroll-top-btn"
          aria-label="الرجوع للأعلى"
          onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
        >
          <i className="fas fa-arrow-up" aria-hidden="true"></i>
        </button>
      )}
    </>
  );
}
