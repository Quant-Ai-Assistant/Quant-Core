package com.quant.assistant

import android.service.voice.VoiceInteractionService

/** Present so Android offers Quant as the digital assistant; each request opens a session. */
class QuantAssistService : VoiceInteractionService()
