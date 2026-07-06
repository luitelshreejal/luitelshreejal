import { useEffect, useRef, useState } from "react";
import profileImg from "@/assets/profile.png";
import { Youtube, Linkedin } from "lucide-react";

const rotations = [
  {
    role: "Rare Disease, Global Regulatory Sciences",
    period: "Nov 2025 – Present",
    detail: "Supporting pediatric and adult programs in hemophilia and sickle cell disease across US and EU markets. Focused on submission planning and regulatory strategy for FDA and EMA.",
  },
  {
    role: "Research — Systems Immunology",
    period: "Jun 2025 – Dec 2025",
    detail: "Built drug-target prioritization models, shipped an LLM literature-review workflow, and integrated clinical datasets/APIs into one research pipeline.",
  },
];

const experiences = [
  {
    period: "Jun 2025 – Present",
    role: "Rotational Program",
    org: "Pfizer",
    children: rotations,
  },
  {
    period: "Feb 2025 – Nov 2025",
    role: "Co-Founder & Instructor",
    org: "Berkeley Banatao Center for GLOBE",
    detail: "Co-created and taught an ML/deep learning program for low-income high school students. Led curriculum design, recruiting, and instruction.",
  },
  {
    period: "Aug 2024 – May 2025",
    role: "Data Science Contractor",
    org: "MSCI Inc.",
  },
];

const education = [
  {
    degree: "Master's in Operations Research",
    school: "UC Berkeley",
    note: "Dean's full scholarship",
  },
  {
    degree: "Bachelors in Industrial Engineering & Operations Research",
    school: "UC Berkeley",
    note: "Fiat Lux scholarship · Skydeck Co-Founder · SCET Certificate · Form+Fund Law Fellow",
  },
];

const volunteering = [
  { role: "Student Trustee", org: "Contra Costa CCD", note: "Elected to represent 50,000+ students across 3 colleges" },
  { role: "Advisory Board Member", org: "Hack the Hood" },
  { role: "Student Mentor", org: "METAS CCC" },
];

const works = [
  {
    title: "GLOBE ML Lecture Series",
    description: "Public lecture playlist on YouTube",
    url: "https://www.youtube.com/watch?v=3G1dyCEePoY&list=PLYQ9Y6GlLMJp8-Hmbtc4ubOCtDvCrtnhJ",
    type: "video" as const
  },
];

/* Reveals children with a soft rise once they scroll into view. */
const Reveal = ({
  children,
  className = "",
}: {
  children: React.ReactNode;
  className?: string;
}) => {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry.isIntersecting) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { threshold: 0.15, rootMargin: "0px 0px -40px 0px" },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={ref} className={`reveal ${visible ? "is-visible" : ""} ${className}`}>
      {children}
    </div>
  );
};

const Section = ({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) => (
  <Reveal>
    <section className="mb-16">
      <h2 className="text-xs font-medium uppercase tracking-widest text-muted-foreground mb-6">{title}</h2>
      {children}
    </section>
  </Reveal>
);

const Divider = () => (
  <Reveal>
    <div className="h-px bg-border mb-16" />
  </Reveal>
);

const Index = () => {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto max-w-xl px-6 py-20 md:py-32">
        {/* Profile — staggered rise on load */}
        <div className="flex flex-col items-center text-center mb-16">
          <img
            src={profileImg}
            alt="Shreejal Luitel"
            width={120}
            height={120}
            className="animate-rise rounded-full object-cover mb-6 border border-border"
          />
          <h1
            className="animate-rise text-3xl font-semibold tracking-tight mb-3"
            style={{ animationDelay: "0.12s" }}
          >
            Shreejal Luitel
          </h1>
          <p
            className="animate-rise text-muted-foreground text-sm leading-relaxed max-w-sm"
            style={{ animationDelay: "0.24s" }}
          >
            I work at the intersection of regulatory science, AI, and drug development. I am currently in Global Regulatory Sciences at Pfizer, focused on rare disease programs.
          </p>
          <a
            href="https://linkedin.com/in/shreejal-luitel"
            target="_blank"
            rel="noopener noreferrer"
            className="animate-rise mt-5 text-muted-foreground hover:text-foreground transition-colors"
            style={{ animationDelay: "0.36s" }}
            aria-label="LinkedIn"
          >
            <Linkedin className="w-4 h-4" />
          </a>
        </div>

        <Divider />

        {/* Experience */}
        <Section title="Experience">
          <div className="space-y-6">
            {experiences.map((exp, i) => (
              <div key={i}>
                <div className="flex justify-between items-baseline gap-4">
                  <p className="text-sm font-medium">{exp.role}</p>
                  <span className="text-xs text-muted-foreground whitespace-nowrap">{exp.period}</span>
                </div>
                <p className="text-xs text-muted-foreground">{exp.org}</p>
                {"detail" in exp && exp.detail && (
                  <p className="text-xs text-muted-foreground/80 mt-1 leading-relaxed">{exp.detail}</p>
                )}
                {"children" in exp && exp.children && (
                  <div className="mt-3 ml-3 border-l border-border pl-4 space-y-4">
                    {exp.children.map((rot, j) => (
                      <div key={j}>
                        <div className="flex justify-between items-baseline gap-4">
                          <p className="text-xs font-medium">{rot.role}</p>
                          <span className="text-[11px] text-muted-foreground whitespace-nowrap">{rot.period}</span>
                        </div>
                        {rot.detail && (
                          <p className="text-xs text-muted-foreground/80 mt-1 leading-relaxed">{rot.detail}</p>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        </Section>

        <Divider />

        {/* Education */}
        <Section title="Education">
          <div className="space-y-4">
            {education.map((edu, i) => (
              <div key={i}>
                <p className="text-sm font-medium">{edu.degree}</p>
                <p className="text-xs text-muted-foreground">{edu.school}</p>
                {edu.note && <p className="text-xs text-muted-foreground/70 mt-0.5">{edu.note}</p>}
              </div>
            ))}
          </div>
        </Section>

        <Divider />

        {/* Volunteering */}
        <Section title="Community">
          <div className="space-y-3">
            {volunteering.map((v, i) => (
              <div key={i}>
                <p className="text-sm font-medium">{v.role}</p>
                <p className="text-xs text-muted-foreground">{v.org}</p>
                {v.note && <p className="text-xs text-muted-foreground/70 mt-0.5">{v.note}</p>}
              </div>
            ))}
          </div>
        </Section>

        <Divider />

        {/* Work */}
        <Section title="Selected Links">
          <div className="space-y-3">
            {works.map((work, i) => (
              <a
                key={i}
                href={work.url}
                target="_blank"
                rel="noopener noreferrer"
                className="flex items-center justify-between gap-4 p-3 -mx-3 rounded-lg hover:bg-accent transition-colors group"
              >
                <div>
                  <p className="text-sm font-medium">{work.title}</p>
                  <p className="text-xs text-muted-foreground">{work.description}</p>
                </div>
                {work.type === "video" && (
                  <Youtube className="w-4 h-4 text-muted-foreground shrink-0" />
                )}
              </a>
            ))}
          </div>
        </Section>
      </div>
    </div>
  );
};

export default Index;
