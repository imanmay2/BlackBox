import { GAME_CONFIG } from "@/config/game";
import { connectToDatabase } from "@/lib/db/mongodb";
import { Progress } from "@/models/Progress";
import { Team } from "@/models/Team";

export const SCORING_CONFIG = {
  initialPoints: 500,           // Max points per module for 1st solver
  minimumPoints: 100,           // Minimum points floor per module
  decaySolves: 20,              // Solves count over which score decays to minimum
  penaltyPerWrongAttempt: 0,   // Points deducted per incorrect submission
} as const;

/**
 * CTFd Dynamic Scoring Formula:
 * Calculates the current point value of a module based on how many teams have solved it.
 *
 * Formula:
 *   step = (minimumPoints - initialPoints) / (decaySolves ^ 2)
 *   value = round(step * (solvesCount - 1)^2 + initialPoints)
 *   result = max(minimumPoints, value)
 */
export function calculateModulePoints(
  solvesCount: number,
  initial: number = SCORING_CONFIG.initialPoints,
  minimum: number = SCORING_CONFIG.minimumPoints,
  decaySolves: number = SCORING_CONFIG.decaySolves
): number {
  if (solvesCount <= 0) return initial;
  if (solvesCount === 1) return initial;

  const step = (minimum - initial) / Math.pow(decaySolves, 2);
  const solvesTerm = Math.pow(solvesCount - 1, 2);
  const rawValue = Math.round(step * solvesTerm + initial);

  return Math.max(minimum, rawValue);
}

export type LeaderboardEntry = {
  rank: number;
  teamId: string;
  teamName: string;
  score: number;
  currentModule: number;
  modulesCompleted: number;
  totalAttempts: number;
  penalties: number;
  lastSolveAt: string | null;
};

/**
 * Recalculates scores for ALL teams in real-time according to CTFd retroactive dynamic scoring.
 * Also updates each Team document's `score` field in MongoDB.
 */
export async function recalculateAllTeamScores(): Promise<Map<string, number>> {
  await connectToDatabase();

  // 1. Get completion count per module
  const solveCountsAggregation = await Progress.aggregate<{ _id: number; count: number }>([
    { $match: { completed: true } },
    { $group: { _id: "$module", count: { $sum: 1 } } },
  ]);

  const moduleSolveCounts = new Map<number, number>();
  solveCountsAggregation.forEach((item) => {
    moduleSolveCounts.set(item._id, item.count);
  });

  // Calculate current point value for each module (1 through totalModules)
  const moduleValues = new Map<number, number>();
  for (let m = GAME_CONFIG.firstModule; m <= GAME_CONFIG.totalModules; m++) {
    const solves = moduleSolveCounts.get(m) ?? 0;
    moduleValues.set(m, calculateModulePoints(solves));
  }

  // 2. Fetch all progress records
  const allProgress = await Progress.find({}).lean();

  // Group progress by teamId
  const teamProgressMap = new Map<
    string,
    { completedModules: number[]; attempts: number }
  >();

  allProgress.forEach((p) => {
    const teamData = teamProgressMap.get(p.teamId) ?? { completedModules: [], attempts: 0 };
    if (p.completed) {
      teamData.completedModules.push(p.module);
    }
    teamData.attempts += p.attempts || 0;
    teamProgressMap.set(p.teamId, teamData);
  });

  // 3. Calculate score for each team & bulk update Team score
  const teamScores = new Map<string, number>();
  const bulkOps: Array<{
    updateOne: {
      filter: { teamId: string };
      update: { $set: { score: number } };
    };
  }> = [];

  teamProgressMap.forEach((data, teamId) => {
    let rawScore = 0;
    data.completedModules.forEach((mod) => {
      rawScore += moduleValues.get(mod) ?? SCORING_CONFIG.initialPoints;
    });

    // Deduct penalties for extra attempts beyond the 1 successful solve attempt
    const extraAttempts = Math.max(0, data.attempts - data.completedModules.length);
    const penalty = extraAttempts * SCORING_CONFIG.penaltyPerWrongAttempt;
    const finalScore = Math.max(0, rawScore - penalty);

    teamScores.set(teamId, finalScore);
    bulkOps.push({
      updateOne: {
        filter: { teamId },
        update: { $set: { score: finalScore } },
      },
    });
  });

  if (bulkOps.length > 0) {
    await Team.bulkWrite(bulkOps);
  }

  return teamScores;
}

/**
 * Generates the full dynamic CTFd Leaderboard, sorted by:
 * 1. Score (DESC)
 * 2. Last completion timestamp (ASC — tiebreaker)
 */
export async function getLeaderboard(): Promise<LeaderboardEntry[]> {
  await connectToDatabase();

  // Ensure team scores are up-to-date
  await recalculateAllTeamScores();

  // Fetch all teams
  const teams = await Team.find({}).select("teamId teamName currentModule score").lean();

  // Fetch all progress to get last solve timestamps & attempt stats
  const allProgress = await Progress.find({}).lean();

  const teamStatsMap = new Map<
    string,
    {
      modulesCompleted: number;
      totalAttempts: number;
      lastSolveAt: Date | null;
    }
  >();

  allProgress.forEach((p) => {
    const stats = teamStatsMap.get(p.teamId) ?? {
      modulesCompleted: 0,
      totalAttempts: 0,
      lastSolveAt: null,
    };

    stats.totalAttempts += p.attempts || 0;

    if (p.completed && p.completedAt) {
      stats.modulesCompleted += 1;
      const completedDate = new Date(p.completedAt);
      if (!stats.lastSolveAt || completedDate > stats.lastSolveAt) {
        stats.lastSolveAt = completedDate;
      }
    }

    teamStatsMap.set(p.teamId, stats);
  });

  // Build leaderboard entries
  const entries: Array<Omit<LeaderboardEntry, "rank">> = teams.map((team) => {
    const stats = teamStatsMap.get(team.teamId) ?? {
      modulesCompleted: 0,
      totalAttempts: 0,
      lastSolveAt: null,
    };

    const extraAttempts = Math.max(0, stats.totalAttempts - stats.modulesCompleted);
    const penalties = extraAttempts * SCORING_CONFIG.penaltyPerWrongAttempt;

    return {
      teamId: team.teamId,
      teamName: team.teamName,
      score: team.score ?? 0,
      currentModule: team.currentModule,
      modulesCompleted: stats.modulesCompleted,
      totalAttempts: stats.totalAttempts,
      penalties,
      lastSolveAt: stats.lastSolveAt ? stats.lastSolveAt.toISOString() : null,
    };
  });

  // Sort: Score (DESC), then lastSolveAt (ASC)
  entries.sort((a, b) => {
    if (b.score !== a.score) {
      return b.score - a.score;
    }

    // Tie-breaker: earlier last solve time wins
    if (a.lastSolveAt && b.lastSolveAt) {
      return new Date(a.lastSolveAt).getTime() - new Date(b.lastSolveAt).getTime();
    }
    if (a.lastSolveAt) return -1;
    if (b.lastSolveAt) return 1;

    return a.teamName.localeCompare(b.teamName);
  });

  // Assign ranks
  return entries.map((entry, index) => ({
    rank: index + 1,
    ...entry,
  }));
}
