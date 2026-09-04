package expo.modules.workoutworker.utils

import android.app.Notification
import android.app.NotificationManager
import android.content.Context
import android.media.AudioAttributes
import android.media.AudioDeviceInfo
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.media.ToneGenerator
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log
import androidx.annotation.DrawableRes
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE
import androidx.core.app.NotificationManagerCompat
import expo.modules.workoutworker.R
import expo.modules.workoutworker.WorkoutConstants.getLaunchAppAtWorkoutPagePendingIntent
import expo.modules.workoutworker.WorkoutConstants.getLiveUpdateDeleteIntent


// Which stage of a rest break the timer is in, and the small icon that marks it in the notification
// (both the promoted Live Update chip and the plain notification on pre-Android-16 devices).
enum class RestWindow(@DrawableRes val icon: Int) {
    RESTING(R.drawable.hourglass_empty_24px),   // before the minimum rest is up
    READY(R.drawable.play_arrow_24px),          // between minimum and maximum rest
    DONE(R.drawable.check_24px);                 // past the maximum rest

    companion object {
        fun of(nowSecs: Long, minRestEndSecs: Long, maxRestEndSecs: Long): RestWindow = when {
            nowSecs < minRestEndSecs -> RESTING
            nowSecs < maxRestEndSecs -> READY
            else -> DONE
        }
    }
}


class WorkoutNotificationManager(private val context: Context) {

    private val audioManager = context.getSystemService(AudioManager::class.java)
    private val restToneHandler = Handler(Looper.getMainLooper())
    private var restToneGenerator: ToneGenerator? = null
    private var restToneAudioFocusRequest: AudioFocusRequest? = null
    private val audioFocusChangeListener = AudioManager.OnAudioFocusChangeListener { focusChange ->
        if (focusChange == AudioManager.AUDIOFOCUS_LOSS || focusChange == AudioManager.AUDIOFOCUS_LOSS_TRANSIENT) {
            releaseRestToneGenerator(audioManager)
        }
    }

    companion object {
        const val PERSISTENT_NOTIFICATION_ID = 123
        const val REST_NOTIFICATION_ID = 1234

        const val PERSISTENT_CHANNEL_ID = "workout_channel"
        const val REST_CHANNEL_ID = "rest_channel"

        private const val REST_TONE_DURATION_MS = 600
        private const val REST_TONE_VOLUME_PERCENT = 100
        private const val REST_TONE_TYPE = ToneGenerator.TONE_DTMF_5

        private val HEADPHONE_AUDIO_DEVICE_TYPES = setOf(
            AudioDeviceInfo.TYPE_BLE_HEADSET,
            AudioDeviceInfo.TYPE_BLUETOOTH_A2DP,
            AudioDeviceInfo.TYPE_USB_HEADSET,
            AudioDeviceInfo.TYPE_WIRED_HEADPHONES,
            AudioDeviceInfo.TYPE_WIRED_HEADSET,
        )

        private val REST_TONE_AUDIO_ATTRIBUTES = AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_MEDIA)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build()
    }

    // Set once the user swipes the Live Update away; from then on we stop requesting promotion so
    // Android doesn't revoke our permission for re-posting a dismissed promoted notification.
    @Volatile
    private var promotionDismissed = false

    fun onLiveUpdateDismissed() {
        promotionDismissed = true
    }

    fun resetPromotion() {
        promotionDismissed = false
    }

    private fun canPromote(): Boolean =
        !promotionDismissed && NotificationManagerCompat.from(context).canPostPromotedNotifications()

    fun createWorkoutNotificationBuilder(promote: Boolean = true): NotificationCompat.Builder {
        return NotificationCompat.Builder(context, PERSISTENT_CHANNEL_ID)
            .setContentTitle("LiftLog")
            // Without this the notification defaults to VISIBILITY_PRIVATE and gets redacted to a
            // blank outline on a secure lock screen when "show sensitive content" is off.
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setForegroundServiceBehavior(FOREGROUND_SERVICE_IMMEDIATE)
            .setContentIntent(context.getLaunchAppAtWorkoutPagePendingIntent())
            .setDeleteIntent(context.getLiveUpdateDeleteIntent())
            .setSmallIcon(R.drawable.fitness_center_24px)
            .setOngoing(true)
            .setSilent(true)
            .setOnlyAlertOnce(true)
            .setRequestPromotedOngoing(promote && canPromote())
    }

    // A promoted progress bar for the active timer. `partialThreshold` splits the bar into a min-rest
    // and max-rest segment with a point at the boundary; an indeterminate bar is used when the end is
    // unknowable (e.g. a distance cardio target) or already passed.
    fun timerProgressStyle(
        progress: Int,
        max: Int,
        partialThreshold: Int? = null,
        indeterminate: Boolean = false,
    ): NotificationCompat.ProgressStyle {
        if (indeterminate || max <= 0) {
            return NotificationCompat.ProgressStyle().setProgressIndeterminate(true)
        }
        val style = NotificationCompat.ProgressStyle().setProgress(progress.coerceIn(0, max))
        if (partialThreshold != null && partialThreshold in 1 until max) {
            style.setProgressSegments(
                listOf(
                    NotificationCompat.ProgressStyle.Segment(partialThreshold),
                    NotificationCompat.ProgressStyle.Segment(max - partialThreshold),
                )
            ).addProgressPoint(NotificationCompat.ProgressStyle.Point(partialThreshold))
        } else {
            style.setProgressSegments(listOf(NotificationCompat.ProgressStyle.Segment(max)))
        }
        return style
    }

    fun createRestNotificationBuilder(): NotificationCompat.Builder {
        return NotificationCompat.Builder(context, REST_CHANNEL_ID)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setForegroundServiceBehavior(FOREGROUND_SERVICE_IMMEDIATE)
            .setContentIntent(context.getLaunchAppAtWorkoutPagePendingIntent())
            .setSmallIcon(R.drawable.fitness_center_24px)
            .setOngoing(false)
            .setSilent(false)
            .setOnlyAlertOnce(true)
    }


    fun notifyPersistent(notification: android.app.Notification) {
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.notify(PERSISTENT_NOTIFICATION_ID, notification)
    }

    fun notifyRest(notification: Notification) {
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.notify(REST_NOTIFICATION_ID, notification)
        playRestToneThroughHeadphonesWhenNotificationsAreMuted()
    }

    /**
     * Android mutes notification audio in vibrate and silent modes, even when media is playing through
     * headphones. In that specific situation, play a generated tone as media so the rest alert reaches
     * the headphones without making a vibrate-only phone audible in the room.
     */
    private fun playRestToneThroughHeadphonesWhenNotificationsAreMuted() {
        if (
            audioManager.ringerMode == AudioManager.RINGER_MODE_NORMAL ||
            !audioManager.hasHeadphoneOutput()
        ) {
            return
        }

        releaseRestToneGenerator(audioManager)
        if (!requestRestToneAudioFocus(audioManager)) return

        try {
            val generator = ToneGenerator(AudioManager.STREAM_MUSIC, REST_TONE_VOLUME_PERCENT)
            restToneGenerator = generator
            if (!generator.startTone(REST_TONE_TYPE, REST_TONE_DURATION_MS)) {
                releaseRestToneGenerator(audioManager)
                Log.e("WorkoutNotificationManager", "Failed to start generated rest tone")
                return
            }

            restToneHandler.postDelayed({
                if (restToneGenerator === generator) {
                    releaseRestToneGenerator(audioManager)
                }
            }, REST_TONE_DURATION_MS.toLong())
        } catch (e: Exception) {
            releaseRestToneGenerator(audioManager)
            Log.e("WorkoutNotificationManager", "Failed to play rest tone through headphones", e)
        }
    }

    private fun requestRestToneAudioFocus(audioManager: AudioManager): Boolean {
        val result = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
                .setAudioAttributes(REST_TONE_AUDIO_ATTRIBUTES)
                .setOnAudioFocusChangeListener(audioFocusChangeListener)
                .build()
            restToneAudioFocusRequest = request
            audioManager.requestAudioFocus(request)
        } else {
            @Suppress("DEPRECATION")
            audioManager.requestAudioFocus(
                audioFocusChangeListener,
                AudioManager.STREAM_MUSIC,
                AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK,
            )
        }
        val granted = result == AudioManager.AUDIOFOCUS_REQUEST_GRANTED
        if (!granted) restToneAudioFocusRequest = null
        return granted
    }

    private fun releaseRestToneGenerator(audioManager: AudioManager) {
        restToneGenerator?.stopTone()
        restToneGenerator?.release()
        restToneGenerator = null
        abandonRestToneAudioFocus(audioManager)
    }

    private fun abandonRestToneAudioFocus(audioManager: AudioManager) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            restToneAudioFocusRequest?.let(audioManager::abandonAudioFocusRequest)
            restToneAudioFocusRequest = null
        } else {
            @Suppress("DEPRECATION")
            audioManager.abandonAudioFocus(audioFocusChangeListener)
        }
    }

    private fun AudioManager.hasHeadphoneOutput(): Boolean =
        getDevices(AudioManager.GET_DEVICES_OUTPUTS).any { device ->
            device.type in HEADPHONE_AUDIO_DEVICE_TYPES
        }

    fun clearPersistentNotification() {
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.cancel(PERSISTENT_NOTIFICATION_ID)
    }

    fun clearRestNotification() {
        val manager = context.getSystemService(NotificationManager::class.java)
        manager.cancel(REST_NOTIFICATION_ID)
    }
}
