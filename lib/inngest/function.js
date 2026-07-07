import { db } from "@/lib/prisma";
import { inngest } from "./client";
import { GoogleGenerativeAI } from "@google/generative-ai";

if (!process.env.GEMINI_API_KEY) {
  throw new Error("GEMINI_API_KEY is not set in environment");
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

async function pickGenerativeModel(step) {
  try {
    const list = await genAI.models.list();
    const models = list.models ?? [];

    const candidate =
      models.find((m) => /gemini/i.test(m.name ?? "")) ??
      models.find((m) => /(bison|text)/i.test(m.name ?? ""));

    if (!candidate) {
      step?.log?.("No suitable generative model found");
      throw new Error("No generative model found");
    }

    return candidate.name.replace("models/", "");
  } catch (err) {
    console.error("Error selecting model:", err);
    throw err;
  }
}

export const generateIndustryInsights = inngest.createFunction(
  { name: "Generate Industry Insights" },
  { cron: "0 0 * * 0" }, // every Sunday
  async ({ step }) => {
    const modelId = await step.run("Select model", async () => {
      return await pickGenerativeModel(step);
    });

    const model = genAI.getGenerativeModel({ model: modelId });

    const industries = await step.run("Fetch industries", async () => {
      return await db.industryInsight.findMany({ select: { industry: true } });
    });

    for (const { industry } of industries) {
      const prompt = `
        Analyze the current state of the ${industry} industry and provide insights in ONLY the following JSON format:
        {
          "salaryRanges": [
            { "role": "string", "min": number, "max": number, "median": number, "location": "string" }
          ],
          "growthRate": number,
          "demandLevel": "High" | "Medium" | "Low",
          "topSkills": ["skill1", "skill2"],
          "marketOutlook": "Positive" | "Neutral" | "Negative",
          "keyTrends": ["trend1", "trend2"],
          "recommendedSkills": ["skill1", "skill2"]
        }
        Return ONLY the JSON.
      `;

      let text;
      try {
        text = await step.ai.wrap(
          "generative-model",
          async (p) => {
            const result = await model.generateContent(p);
            return await result.response.text();
          },
          prompt
        );
      } catch (err) {
        console.error(`AI request failed for ${industry}:`, err);
        continue;
      }

      const cleanedText = text.replace(/```(?:json)?|```/g, "").trim();

      let insights;
      try {
        insights = JSON.parse(cleanedText);
      } catch (err) {
        console.error(`Failed to parse JSON for ${industry}:`, cleanedText);
        continue;
      }

      await step.run(`Update ${industry} insights`, async () => {
        await db.industryInsight.update({
          where: { industry },
          data: {
            ...insights,
            lastUpdated: new Date(),
            nextUpdate: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
          },
        });
      });
    }
  }
);
