const express = require("express");

const asyncHandler = require("../utils/asyncHandler");
const { requireAuth } = require("../middleware/auth");

const Resume = require("../models/Resume");
const ResumeVersion = require("../models/ResumeVersion");
const Analysis = require("../models/Analysis");

const router = express.Router();

router.use(requireAuth);

/* -------------------- Dashboard -------------------- */

router.get(
  "/",
  asyncHandler(async (req, res) => {
    const userId = req.user._id;

    /* -------------------- Resumes -------------------- */

    const resumes = await Resume.find({
      userId,
    })
      .sort({ updatedAt: -1 })
      .lean();

    const resumeIds = resumes.map((r) => r._id);

    /* -------------------- Basic Counts -------------------- */

    const [rewriteCount, analysisCount] =
      await Promise.all([
        ResumeVersion.countDocuments({
          resumeId: { $in: resumeIds },
          sourceType: "rewrite",
        }),

        Analysis.countDocuments({
          userId,
        }),
      ]);

    /* -------------------- Latest Resume -------------------- */

    const latestResumeMeta = resumes[0] || null;

    let latestResume = null;
    let scoreSeries = [];
    let versionStack = [];

    if (latestResumeMeta) {
      const versions = await ResumeVersion.find({
        resumeId: latestResumeMeta._id,
      })
        .sort({ versionNumber: 1 })
        .lean();

      /* -------------------- Latest Resume Versions + Scores -------------------- */

      const analysisIds = versions
        .map((v) => v.latestAnalysisId)
        .filter(Boolean);

      const analyses = analysisIds.length
        ? await Analysis.find({
            _id: { $in: analysisIds },
          })
            .select("_id atsScore versionId createdAt")
            .sort({ createdAt: -1 })
            .lean()
        : [];

      const scoreByVersion = new Map(
        analyses.map((a) => [
          a.versionId.toString(),
          a.atsScore,
        ])
      );

      const versionsWithScores = versions.map((v) => ({
        id: v._id,
        label: v.label,
        versionNumber: v.versionNumber,
        sourceType: v.sourceType,
        createdAt: v.createdAt,

        score:
          scoreByVersion.get(v._id.toString()) ?? null,
      }));

      /* -------------------- Latest Resume -------------------- */

      latestResume = {
        _id: latestResumeMeta._id,
        title: latestResumeMeta.title,
        latestVersionNumber:
          latestResumeMeta.latestVersionNumber,
        updatedAt: latestResumeMeta.updatedAt,
        currentVersionId:
          latestResumeMeta.currentVersionId,
      };

      /* -------------------- Score Series -------------------- */

      scoreSeries = versionsWithScores
        .filter((v) => v.score != null)
        .map((v) => ({
          label: v.label,
          score: v.score,
          versionId: v.id,
          at: v.createdAt,
        }));

      /* -------------------- Version Stack -------------------- */

      const last3 = versionsWithScores.slice(-3);

      versionStack = last3.map((v, i, arr) => {
        const prev = arr[i - 1];

        const delta =
          v.score != null &&
          prev?.score != null
            ? v.score - prev.score
            : 0;

        return {
          id: v.id,
          label: v.label,

          title:
            v.sourceType === "upload"
              ? "Upload"
              : v.sourceType === "rewrite"
              ? "Rewrite pass"
              : v.label,

          score: v.score ?? 0,
          delta,
        };
      });
    }

    /* -------------------- Historical KPIs -------------------- */

    const allAnalyses = await Analysis.find({
      userId,
    })
      .select(
        "atsScore keywordsPresent keywordsMissing issues createdAt resumeId"
      )
      .sort({ createdAt: 1 })
      .lean();

    const latestAnalysis =
      allAnalyses[allAnalyses.length - 1] || null;

    const previousAnalysis =
      allAnalyses.length >= 2
        ? allAnalyses[allAnalyses.length - 2]
        : null;

    /* -------------------- Score Sparkline -------------------- */

    const scoreSpark = allAnalyses
      .slice(-10)
      .map((a) => a.atsScore);

    /* -------------------- Version Sparkline -------------------- */

    const versionsSpark = resumes
      .slice(0, 10)
      .reverse()
      .map((r) => r.latestVersionNumber || 1);

    /* -------------------- Keywords Sparkline -------------------- */

    const keywordsSpark = allAnalyses
      .slice(-10)
      .map(
        (a) => (a.keywordsPresent || []).length
      );

    /* -------------------- Issues Sparkline -------------------- */

    const issuesSpark = allAnalyses
      .slice(-10)
      .map(
        (a) => (a.issues || []).length
      );

    /* -------------------- KPI Object -------------------- */

    const kpi = {
      atsScore: {
        value: latestAnalysis?.atsScore ?? null,

        delta:
          latestAnalysis && previousAnalysis
            ? latestAnalysis.atsScore -
              previousAnalysis.atsScore
            : null,

        spark: scoreSpark,
      },

      versions: {
        value: resumes.reduce(
          (sum, r) =>
            sum + (r.latestVersionNumber || 1),
          0
        ),

        delta: null,

        spark: versionsSpark,
      },

      issuesIdentified: {
        value: latestAnalysis
          ? (latestAnalysis.issues || []).length
          : null,

        delta:
          latestAnalysis && previousAnalysis
            ? (latestAnalysis.issues || []).length -
              (previousAnalysis.issues || []).length
            : null,

        spark: issuesSpark,
      },

      keywordsMatched: {
        value: latestAnalysis
          ? (latestAnalysis.keywordsPresent || []).length
          : null,

        total: latestAnalysis
          ? (latestAnalysis.keywordsPresent || [])
              .length +
            (latestAnalysis.keywordsMissing || [])
              .length
          : null,

        delta:
          latestAnalysis && previousAnalysis
            ? (latestAnalysis.keywordsPresent || [])
                .length -
              (previousAnalysis.keywordsPresent || [])
                .length
            : null,

        spark: keywordsSpark,
      },
    };

    /* -------------------- Recent Activity -------------------- */

    const resumeMap = new Map(
      resumes.map((r) => [
        r._id.toString(),
        r,
      ])
    );

    const [recentVersions, recentAnalyses] =
      await Promise.all([
        ResumeVersion.find({
          resumeId: { $in: resumeIds },
        })
          .sort({ createdAt: -1 })
          .limit(10)
          .select(
            "resumeId label versionNumber sourceType createdAt"
          )
          .lean(),

        Analysis.find({
          userId,
        })
          .sort({ createdAt: -1 })
          .limit(10)
          .select(
            "resumeId versionId atsScore createdAt"
          )
          .lean(),
      ]);

    const events = [];

    /* -------------------- Upload Events -------------------- */

    for (const r of resumes.slice(0, 10)) {
      events.push({
        id: `v-${r._id}`,

        type: "upload",

        title: r.title,

        subtitle: "Parsed and version V1 created",

        label: "V1 created",

        at: r.createdAt,

        resumeId: r._id,
      });
    }

    /* -------------------- Rewrite Events -------------------- */

    for (const v of recentVersions) {
      if (v.sourceType !== "rewrite") {
        continue;
      }

      const resume =
        resumeMap.get(v.resumeId.toString());

      events.push({
        id: `v-${v._id}`,

        type: "rewrite",

        title: `${v.label} created for ${
          resume?.title || "resume"
        }`,

        subtitle: "Rewrites applied",

        label: `${v.label} created`,

        at: v.createdAt,

        resumeId: v.resumeId,
      });
    }

    /* -------------------- Analysis Events -------------------- */

    for (const a of recentAnalyses) {
      const resume =
        resumeMap.get(a.resumeId.toString());

      events.push({
        id: `a-${a._id}`,

        type: "analyze",

        title: `Analysis complete on ${
          resume?.title || "resume"
        }`,

        subtitle: `ATS score ${a.atsScore} / 100`,

        label: `${a.atsScore}`,

        at: a.createdAt,

        resumeId: a.resumeId,
      });
    }

    /* -------------------- Sort Activity -------------------- */

    const activity = events
      .sort(
        (a, b) =>
          new Date(b.at) -
          new Date(a.at)
      )
      .slice(0, 8);

    /* -------------------- Response -------------------- */

    res.json({
      totals: {
        resumes: resumes.length,
        rewrites: rewriteCount,
        analyses: analysisCount,
        exports: 0,
      },

      latestResume,

      scoreSeries,

      versionStack,

      kpi,

      activity,
    });
  })
);

module.exports = router;