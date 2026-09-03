import { ProgramBlueprint } from '@/models/blueprint-models';
import {
  FeedIdentity,
  FeedUser,
  FollowerFeedUser,
  FollowRequestInboxMessage,
  SessionUserEvent,
} from '@/models/feed-models';
import { Session } from '@/models/session-models';
import { ExerciseDescriptor } from '@/models/exercise-models';

export interface FeedBackupData {
  identity: FeedIdentity;
  feedItems: SessionUserEvent[];
  followers: FollowerFeedUser[];
  followed: FeedUser[];
  followRequests: FollowRequestInboxMessage[];
}

export interface BackupData {
  workouts: Session[];
  programs: Record<string, ProgramBlueprint>;
  exercises?: Record<string, ExerciseDescriptor>;
  feed?: FeedBackupData;
}
