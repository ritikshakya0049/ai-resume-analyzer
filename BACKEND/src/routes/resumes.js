const express = require("express");
const { z } = require("zod");
const mongoose = require("mongoose");

const asyncHandler = require("../utils/asyncHandler");
const ApiError = require("../utils/ApiError");

const { requireAuth } = require("../middleware/auth");
const { validate } = require("../middleware/validate");
const { uploadPdf } = require("../middleware/upload");
const { analyzeLimiter } = require("../middleware/rateLimit");

const Resume = require("../models/Resume");
const ResumeVersion = require("../models/ResumeVersion");
const Analysis = require("../models/Analysis");

const { analyzeResume } = require("../services/geminiService");
const { diffText, summarize } = require("../services/diffServices");
const { extractText } = require("../services/pdfService");
const {
  parseResume: parseStructured,
} = require("../services/structuredParser");

const router = express.Router();

router.use(requireAuth);

/* =========================================================
   VALIDATION
========================================================= */

const objectIdSchema = z
  .string()
  .refine((v) => mongoose.isValidObjectId(v), {
    message: "Invalid id",
  });

const idParam = z.object({
  id: objectIdSchema,
});

/* =========================================================
   HELPERS
========================================================= */

async function loadOwnedResume(req) {
  const resume = await Resume.findOne({
    _id: req.params.id,
    userId: req.user._id,
  });

  if (!resume) {
    throw ApiError.notFound("Resume not found");
  }

  return resume;
}

async function loadVersion(resumeId, versionId) {
  const version = await ResumeVersion.findOne({
    _id: versionId,
    resumeId,
  });

  if (!version) {
    throw ApiError.notFound("Version not found");
  }

  return version;
}

/* =========================================================
   UPLOAD RESUME
========================================================= */

router.post(
  "/",
  uploadPdf("file"),

  asyncHandler(async (req, res) => {
    if (!req.file) {
      throw ApiError.badRequest(
        "PDF file is required"
      );
    }

    const { text, meta } = await extractText(
      req.file.buffer
    );

    if (!text || text.trim().length < 50) {
      throw ApiError.badRequest(
        "Could not extract readable text from the PDF"
      );
    }

    const parsedSections =
      await parseStructured(text);

    const title =
      (req.body.title || "").trim() ||
      req.file.originalname.replace(
        /\.pdf$/i,
        ""
      ) ||
      "Untitled Resume";

    const resume = await Resume.create({
      userId: req.user._id,
      title,
      latestVersionNumber: 1,
    });

    const version =
      await ResumeVersion.create({
        resumeId: resume._id,
        versionNumber: 1,
        label: "v1",
        rawText: text,
        parsedSections,
        sourceType: "upload",
        parentVersionId: null,
      });

    resume.currentVersionId =
      version._id;

    await resume.save();

    res.status(201).json({
      resume,
      version,
      meta,
    });
  })
);

/* =========================================================
   GET ALL RESUMES
========================================================= */

router.get(
  "/",

  asyncHandler(async (req, res) => {
    const resumes = await Resume.find({
      userId: req.user._id,
    })
      .sort({ updatedAt: -1 })
      .lean();

    res.json({
      resumes,
    });
  })
);

/* =========================================================
   GET RESUME + VERSIONS
========================================================= */

router.get(
  "/:id",
  validate(idParam, "params"),

  asyncHandler(async (req, res) => {
    const resume =
      await loadOwnedResume(req);

    const versions =
      await ResumeVersion.find({
        resumeId: resume._id,
      })
        .sort({ versionNumber: -1 })
        .select("-rawText")
        .lean();

    res.json({
      resume,
      versions,
    });
  })
);

/* =========================================================
   GET SPECIFIC VERSION
========================================================= */

router.get(
  "/:id/versions/:versionId",

  validate(
    z.object({
      id: objectIdSchema,
      versionId: objectIdSchema,
    }),
    "params"
  ),

  asyncHandler(async (req, res) => {
    const resume =
      await loadOwnedResume(req);

    const version =
      await loadVersion(
        resume._id,
        req.params.versionId
      );

    res.json({
      version,
    });
  })
);

/* =========================================================
   DELETE RESUME
========================================================= */

router.delete(
  "/:id",
  validate(idParam, "params"),

  asyncHandler(async (req, res) => {
    const resume =
      await loadOwnedResume(req);

    await ResumeVersion.deleteMany({
      resumeId: resume._id,
    });

    await Analysis.deleteMany({
      resumeId: resume._id,
    });

    await resume.deleteOne();

    res.json({
      ok: true,
    });
  })
);

/* =========================================================
   ANALYZE VALIDATION
========================================================= */

const analyzeBody = z.object({
  versionId:
    objectIdSchema.optional(),

  targetRole: z
    .string()
    .trim()
    .max(120)
    .optional(),
});

/* =========================================================
   ANALYZE RESUME
========================================================= */

router.post(
  "/:id/analyze",

  analyzeLimiter,

  validate(idParam, "params"),

  validate(analyzeBody, "body"),

  asyncHandler(async (req, res) => {
    const resume =
      await loadOwnedResume(req);

    const versionId =
      req.body.versionId ||
      resume.currentVersionId;

    if (!versionId) {
      throw ApiError.badRequest(
        "No version to analyze"
      );
    }

    const version =
      await loadVersion(
        resume._id,
        versionId
      );

    const {
      analysis,
      model,
      promptTokens,
      responseTokens,
    } = await analyzeResume({
      rawText: version.rawText,
      targetRole: req.body.targetRole,
    });

    const saved =
      await Analysis.create({
        userId: req.user._id,

        resumeId: resume._id,

        versionId: version._id,

        atsScore:
          analysis.atsScore,

        scoreBreakdown:
          analysis.scoreBreakdown,

        issues:
          analysis.issues,

        strengths:
          analysis.strengths,

        bulletRewrites:
          analysis.bulletRewrites,

        keywordsPresent:
          analysis.keywordsPresent,

        keywordsMissing:
          analysis.keywordsMissing,

        summary:
          analysis.summary,

        model,

        promptTokens,

        responseTokens,
      });

    version.latestAnalysisId =
      saved._id;

    await version.save();

    res.status(201).json({
      analysis: saved,
    });
  })
);

/* =========================================================
   GET ALL ANALYSES
========================================================= */

router.get(
  "/:id/analyses",

  validate(idParam, "params"),

  asyncHandler(async (req, res) => {
    const resume =
      await loadOwnedResume(req);

    const analyses =
      await Analysis.find({
        resumeId: resume._id,
      })
        .sort({ createdAt: -1 })
        .lean();

    res.json({
      analyses,
    });
  })
);

/* =========================================================
   GET ANALYSIS FOR VERSION
========================================================= */

router.get(
  "/:id/versions/:versionId/analysis",

  validate(
    z.object({
      id: objectIdSchema,
      versionId: objectIdSchema,
    }),
    "params"
  ),

  asyncHandler(async (req, res) => {
    const resume =
      await loadOwnedResume(req);

    const version =
      await loadVersion(
        resume._id,
        req.params.versionId
      );

    const analysis =
      await Analysis.findOne({
        resumeId: resume._id,
        versionId: version._id,
      })
        .sort({ createdAt: -1 })
        .lean();

    res.json({
      analysis:
        analysis || null,
    });
  })
);

/* =========================================================
   REWRITE VALIDATION
========================================================= */

const rewriteBody = z.object({
  analysisId:
    objectIdSchema,

  rewriteIds: z
    .array(objectIdSchema)
    .optional(),

  label: z
    .string()
    .trim()
    .max(40)
    .optional(),
});

/* =========================================================
   APPLY REWRITES TO TEXT
========================================================= */

function applyRewritesToText(
  rawText,
  rewrites
) {
  let result = rawText;

  for (const r of rewrites) {
    if (
      !r?.original ||
      !r?.rewritten
    ) {
      continue;
    }

    const idx =
      result.indexOf(r.original);

    if (idx >= 0) {
      result =
        result.slice(0, idx) +
        r.rewritten +
        result.slice(
          idx + r.original.length
        );
    } else {
      result += `\n${r.rewritten}`;
    }
  }

  return result;
}

/* =========================================================
   PATCH STRUCTURED SECTIONS
========================================================= */

function patchBulletsInSections(
  sections,
  rewrites
) {
  if (!sections) {
    return null;
  }

  const cloned =
    JSON.parse(
      JSON.stringify(sections)
    );

  for (const r of rewrites) {
    if (
      !r?.original ||
      !r?.rewritten
    ) {
      continue;
    }

    for (
      const exp of
        cloned.experience || []
    ) {
      if (
        !Array.isArray(
          exp.bullets
        )
      ) {
        continue;
      }

      exp.bullets =
        exp.bullets.map((b) =>
          b === r.original
            ? r.rewritten
            : b
        );
    }
  }

  return cloned;
}

/* =========================================================
   CHECK STRUCTURED PARSER RESULT
========================================================= */

function looksEmpty(sections) {
  if (!sections) {
    return true;
  }

  const basics =
    sections.basics || {};

  const hasIdentity =
    basics.name ||
    basics.email ||
    basics.title;

  const hasBody =
    sections.summary ||
    sections.experience?.length ||
    sections.education?.length ||
    sections.skills?.length;

  return !hasIdentity && !hasBody;
}

/* =========================================================
   REWRITE RESUME
========================================================= */

router.post(
  "/:id/rewrite",

  validate(idParam, "params"),

  validate(rewriteBody, "body"),

  asyncHandler(async (req, res) => {
    const resume =
      await loadOwnedResume(req);

    const analysis =
      await Analysis.findOne({
        _id: req.body.analysisId,
        resumeId: resume._id,
      });

    if (!analysis) {
      throw ApiError.notFound(
        "Analysis not found"
      );
    }

    const baseVersion =
      await loadVersion(
        resume._id,
        analysis.versionId
      );

    const selected =
      req.body.rewriteIds?.length
        ? analysis.bulletRewrites.filter(
            (r) =>
              req.body.rewriteIds.includes(
                r._id.toString()
              )
          )
        : analysis.bulletRewrites;

    if (!selected.length) {
      throw ApiError.badRequest(
        "No rewrites selected to apply"
      );
    }

    const newRaw =
      applyRewritesToText(
        baseVersion.rawText,
        selected
      );

    const patchedFromBase =
      patchBulletsInSections(
        baseVersion.parsedSections,
        selected
      );

    const reparsed =
      await parseStructured(newRaw);

    const finalParsed =
      looksEmpty(reparsed)
        ? patchedFromBase
        : reparsed;

    const nextNumber =
      resume.latestVersionNumber + 1;

    const newVersion =
      await ResumeVersion.create({
        resumeId: resume._id,

        versionNumber:
          nextNumber,

        label:
          req.body.label?.trim() ||
          `v${nextNumber}`,

        rawText: newRaw,

        parsedSections:
          finalParsed,

        sourceType: "rewrite",

        parentVersionId:
          baseVersion._id,
      });

    resume.latestVersionNumber =
      nextNumber;

    resume.currentVersionId =
      newVersion._id;

    await resume.save();

    res.status(201).json({
      version: newVersion,
      appliedCount:
        selected.length,
    });
  })
);

/* =========================================================
   DIFF VALIDATION
========================================================= */

const diffQuery = z.object({
  from: objectIdSchema,

  to: objectIdSchema,

  mode: z
    .enum(["words", "lines"])
    .optional(),
});

/* =========================================================
   VERSION DIFF
========================================================= */

router.get(
  "/:id/diff",

  validate(idParam, "params"),

  validate(diffQuery, "query"),

  asyncHandler(async (req, res) => {
    const resume =
      await loadOwnedResume(req);

    const [fromV, toV] =
      await Promise.all([
        loadVersion(
          resume._id,
          req.query.from
        ),

        loadVersion(
          resume._id,
          req.query.to
        ),
      ]);

    const parts =
      diffText(
        fromV.rawText,
        toV.rawText,
        req.query.mode
      );

    res.json({
      from: {
        id: fromV._id,
        label: fromV.label,
        versionNumber:
          fromV.versionNumber,
      },

      to: {
        id: toV._id,
        label: toV.label,
        versionNumber:
          toV.versionNumber,
      },

      parts,

      stats:
        summarize(parts),
    });
  })
);

/* =========================================================
   EXPORT
========================================================= */

module.exports = router;