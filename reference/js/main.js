/* =========================================================
   SALLA SYRIA — JavaScript
   ========================================================= */

document.addEventListener("DOMContentLoaded", () => {
  /* ── 1. NAVBAR: scroll effect & hamburger ── */
  const navbar = document.getElementById("navbar");
  const hamburger = document.getElementById("hamburger");
  const navLinks = document.getElementById("navLinks");

  const updateNavbar = () => {
    if (window.scrollY > 60) {
      navbar.classList.add("scrolled");
    } else {
      navbar.classList.remove("scrolled");
    }
  };
  window.addEventListener("scroll", updateNavbar, { passive: true });
  updateNavbar();

  hamburger.addEventListener("click", () => {
    navLinks.classList.toggle("open");
    hamburger.classList.toggle("active");
  });

  // Close menu when clicking a link
  navLinks.querySelectorAll("a").forEach((link) => {
    link.addEventListener("click", () => {
      navLinks.classList.remove("open");
      hamburger.classList.remove("active");
    });
  });

  /* ── 2. TABS ── */
  const tabBtns = document.querySelectorAll(".tab-btn");
  const tabPanels = document.querySelectorAll(".tab-panel");

  tabBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      const target = btn.dataset.tab;

      tabBtns.forEach((b) => b.classList.remove("active"));
      tabPanels.forEach((p) => p.classList.remove("active"));

      btn.classList.add("active");
      const panel = document.getElementById("tab-" + target);
      if (panel) {
        panel.classList.add("active");
        // animate in
        panel.style.animation = "none";
        panel.offsetHeight; // reflow
        panel.style.animation = "fadeInUp .4s ease both";
      }
    });
  });

  /* ── 3. INTERSECTION OBSERVER — AOS & counters ── */
  const aosEls = document.querySelectorAll("[data-aos]");

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add("aos-animate");
          observer.unobserve(entry.target);
        }
      });
    },
    { threshold: 0.1, rootMargin: "0px 0px -50px 0px" },
  );

  aosEls.forEach((el) => observer.observe(el));

  /* ── 4. COUNTER ANIMATION for hero stats ── */
  const statNums = document.querySelectorAll(".stat-num");

  const parseNum = (str) => {
    const cleaned = str.replace(/[^0-9]/g, "");
    return parseInt(cleaned, 10) || 0;
  };
  const formatNum = (original, current) => {
    if (original.includes("+")) return "+" + current.toLocaleString("ar");
    if (original.includes("/")) return original; // e.g. 24/7
    return current.toLocaleString("ar");
  };

  const animateCounter = (el) => {
    const original = el.textContent.trim();
    if (original.includes("/")) return; // skip 24/7
    const end = parseNum(original);
    if (!end) return;

    let start = 0;
    const duration = 1800;
    const step = (timestamp) => {
      if (!start) start = timestamp;
      const progress = Math.min((timestamp - start) / duration, 1);
      const eased = 1 - Math.pow(1 - progress, 3);
      el.textContent = formatNum(original, Math.floor(eased * end));
      if (progress < 1) requestAnimationFrame(step);
      else el.textContent = original; // restore exact string
    };
    requestAnimationFrame(step);
  };

  const statsSection = document.querySelector(".hero-stats");
  if (statsSection) {
    const statsObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            statNums.forEach(animateCounter);
            statsObserver.unobserve(entry.target);
          }
        });
      },
      { threshold: 0.5 },
    );
    statsObserver.observe(statsSection);
  }

  /* ── 5. SMOOTH ACTIVE NAV LINK on scroll ── */
  const sections = document.querySelectorAll("section[id], footer[id]");
  const navItems = document.querySelectorAll(".nav-links a");

  const sectionObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          const id = entry.target.getAttribute("id");
          navItems.forEach((a) => {
            a.classList.remove("active-nav");
            if (a.getAttribute("href") === "#" + id) {
              a.classList.add("active-nav");
            }
          });
        }
      });
    },
    { threshold: 0.35 },
  );

  sections.forEach((s) => sectionObserver.observe(s));

  // Active nav style
  const style = document.createElement("style");
  style.textContent = `
    .navbar.scrolled .nav-links a.active-nav {
      color: var(--primary) !important;
      background: var(--green-50);
    }
    .nav-links a.active-nav {
      color: white !important;
      background: rgba(255,255,255,.18);
    }
  `;
  document.head.appendChild(style);

  /* ── 6. SECTOR CARD — hover sound-free ripple effect ── */
  document.querySelectorAll(".sector-card").forEach((card) => {
    card.addEventListener("click", function (e) {
      const ripple = document.createElement("span");
      ripple.style.cssText = `
        position:absolute;
        border-radius:50%;
        background:rgba(22,163,74,.18);
        transform:scale(0);
        animation:ripple .5s linear;
        pointer-events:none;
        width:100px;height:100px;
        left:${e.clientX - card.getBoundingClientRect().left - 50}px;
        top:${e.clientY - card.getBoundingClientRect().top - 50}px;
      `;
      card.appendChild(ripple);
      setTimeout(() => ripple.remove(), 600);
    });
  });

  // Ripple keyframe
  const rippleStyle = document.createElement("style");
  rippleStyle.textContent = `@keyframes ripple { to { transform: scale(4); opacity: 0; } }`;
  document.head.appendChild(rippleStyle);

  /* ── 7. SCROLL-TO-TOP button ── */
  const scrollTopBtn = document.createElement("button");
  scrollTopBtn.innerHTML = '<i class="fas fa-arrow-up"></i>';
  scrollTopBtn.setAttribute("aria-label", "الرجوع للأعلى");
  scrollTopBtn.style.cssText = `
    position:fixed;
    bottom:28px;
    left:24px;
    width:46px;height:46px;
    border-radius:50%;
    background:var(--primary);
    color:#fff;
    border:none;
    cursor:pointer;
    display:none;
    align-items:center;
    justify-content:center;
    font-size:1rem;
    box-shadow:0 4px 16px rgba(22,163,74,.4);
    z-index:999;
    transition:all .3s ease;
  `;
  document.body.appendChild(scrollTopBtn);

  window.addEventListener(
    "scroll",
    () => {
      if (window.scrollY > 400) {
        scrollTopBtn.style.display = "flex";
      } else {
        scrollTopBtn.style.display = "none";
      }
    },
    { passive: true },
  );

  scrollTopBtn.addEventListener("click", () => {
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
  scrollTopBtn.addEventListener("mouseenter", () => {
    scrollTopBtn.style.transform = "translateY(-3px) scale(1.05)";
  });
  scrollTopBtn.addEventListener("mouseleave", () => {
    scrollTopBtn.style.transform = "";
  });
});
