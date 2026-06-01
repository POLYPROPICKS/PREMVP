import { MetadataRoute } from "next";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: "https://polypropicks.com/",
      lastModified: new Date(),
      changeFrequency: "daily",
      priority: 1,
    },
    {
      url: "https://polypropicks.com/reconstruction",
      lastModified: new Date(),
      changeFrequency: "weekly",
      priority: 0.3,
    },
    {
      url: "https://polypropicks.com/faq",
      lastModified: new Date("2026-05-28"),
      changeFrequency: "monthly",
      priority: 0.7,
    },
    {
      url: "https://polypropicks.com/legal",
      lastModified: new Date("2026-05-28"),
      changeFrequency: "monthly",
      priority: 0.5,
    },
    {
      url: "https://polypropicks.com/terms-of-use",
      lastModified: new Date("2026-05-28"),
      changeFrequency: "monthly",
      priority: 0.5,
    },
    {
      url: "https://polypropicks.com/privacy-policy",
      lastModified: new Date("2026-05-28"),
      changeFrequency: "monthly",
      priority: 0.5,
    },
    {
      url: "https://polypropicks.com/alerts",
      lastModified: new Date("2026-06-01"),
      changeFrequency: "monthly",
      priority: 0.6,
    },
  ];
}
