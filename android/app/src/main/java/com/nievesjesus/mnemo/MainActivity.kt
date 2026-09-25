package com.nievesjesus.mnemo

import android.Manifest
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.os.Bundle
import android.os.SystemClock
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.CompoundButton
import android.widget.EditText
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.Spinner
import android.widget.TextView
import android.widget.Toast
import androidx.activity.result.contract.ActivityResultContracts
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.camera.core.CameraSelector
import androidx.lifecycle.lifecycleScope
import com.meta.wearable.dat.core.Wearables
import com.meta.wearable.dat.core.types.Permission
import com.meta.wearable.dat.core.types.PermissionStatus
import com.meta.wearable.dat.core.types.RegistrationState
import com.meta.wearable.dat.mockdevice.MockDeviceKit
import com.meta.wearable.dat.mockdevice.api.GlassesModel
import com.meta.wearable.dat.mockdevice.api.MockDeviceKitConfig
import com.meta.wearable.dat.mockdevice.api.camera.CameraFacing
import com.nievesjesus.mnemo.capture.CaptureSource
import com.nievesjesus.mnemo.capture.GlassesCameraSource
import com.nievesjesus.mnemo.capture.PhoneCameraSource
import com.nievesjesus.mnemo.output.Announcer
import com.nievesjesus.mnemo.output.VoiceListener
import com.nievesjesus.mnemo.pipeline.NOBODY_PHRASE
import com.nievesjesus.mnemo.pipeline.UNCLEAR_PHRASE
import com.nievesjesus.mnemo.pipeline.Pipeline
import com.nievesjesus.mnemo.pipeline.State
import com.nievesjesus.mnemo.pipeline.Zone
import com.nievesjesus.mnemo.pipeline.centroid
import com.nievesjesus.mnemo.store.Consent
import com.nievesjesus.mnemo.store.SecureGallery
import kotlin.coroutines.resume
import kotlinx.coroutines.CancellableContinuation
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.take
import kotlinx.coroutines.launch
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withContext

/**
 * Vista del portador (P-07/P-08) + controles del banco de pruebas. La app del cuidador completa
 * (P-01 a P-09) está implementada en el demo web; esta actividad se concentra en el ciclo en el
 * dispositivo y en las dos implementaciones de captura.
 */
class MainActivity : AppCompatActivity() {

  private enum class Source(val label: String) {
    PHONE_BACK("Teléfono · cámara trasera"),
    PHONE_FRONT("Teléfono · cámara frontal"),
    GLASSES("Ray-Ban Meta"),
    GLASSES_MOCK("Gafas simuladas (MockDeviceKit)"),
  }

  private lateinit var gallery: SecureGallery
  private lateinit var pipeline: Pipeline
  private lateinit var announcer: Announcer
  private lateinit var preview: ImageView
  private lateinit var status: TextView
  private lateinit var card: TextView
  private var source: CaptureSource? = null
  private var lastSource = Source.PHONE_BACK
  private var loop: Job? = null
  private var privacy = false
  private var wearablesReady = false
  private lateinit var voice: VoiceListener
  /** «¿Quién es?» pedido desde la UI o la voz; lo consume el hilo del pipeline. */
  @Volatile private var askRequested = false
  private var pendingAsk: Pair<Long, Boolean>? = null // (momento, ¿se vio una cara?)

  private val androidPermissions =
      registerForActivityResult(ActivityResultContracts.RequestMultiplePermissions()) { granted ->
        if (granted[Manifest.permission.BLUETOOTH_CONNECT] == true) {
          Wearables.initialize(this) // requerido antes de cualquier API de Wearables
          wearablesReady = true
        }
      }

  private var glassesPermissionCont: CancellableContinuation<PermissionStatus>? = null
  private val glassesPermission =
      registerForActivityResult(Wearables.RequestPermissionContract()) { result ->
        glassesPermissionCont?.resume(result.getOrDefault(PermissionStatus.Denied))
        glassesPermissionCont = null
      }

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    setContentView(R.layout.activity_main)
    preview = findViewById(R.id.preview)
    status = findViewById(R.id.status)
    card = findViewById(R.id.card)
    gallery = SecureGallery(this)
    pipeline = Pipeline(this, gallery)
    announcer = Announcer(this)

    val spinner = findViewById<Spinner>(R.id.source)
    spinner.adapter = ArrayAdapter(this, android.R.layout.simple_spinner_dropdown_item, Source.entries.map { it.label })
    findViewById<Button>(R.id.start).setOnClickListener { start(Source.entries[spinner.selectedItemPosition]) }
    findViewById<Button>(R.id.ask).setOnClickListener { askRequested = true }
    voice = VoiceListener(this, onAsk = { askRequested = true }, onStatus = { runOnUiThread { findViewById<TextView>(R.id.mic).text = it } }, muted = announcer::speaking)
    findViewById<CompoundButton>(R.id.autoChange).setOnCheckedChangeListener { _, on -> pipeline.engine.cfg.announceOnChange = on }
    findViewById<CompoundButton>(R.id.autoUnknown).setOnCheckedChangeListener { _, on -> pipeline.engine.cfg.announceUnknown = on }
    findViewById<CompoundButton>(R.id.listen).setOnCheckedChangeListener { b, on ->
      if (on && !voice.start()) b.isChecked = false else if (!on) voice.stop()
    }
    findViewById<Button>(R.id.privacy).setOnClickListener { togglePrivacy(it as Button) }
    findViewById<Button>(R.id.enroll).setOnClickListener { enroll() }
    findViewById<Button>(R.id.register).setOnClickListener {
      if (wearablesReady) Wearables.startRegistration(this) else toast("Concedé los permisos de Bluetooth primero")
    }

    androidPermissions.launch(arrayOf(Manifest.permission.CAMERA, Manifest.permission.BLUETOOTH_CONNECT, Manifest.permission.RECORD_AUDIO))
    lifecycleScope.launch {
      runCatching {
        Wearables.registrationState.collect { st ->
          findViewById<Button>(R.id.register).text = if (st == RegistrationState.REGISTERED) "Gafas registradas" else "Registrar gafas (Meta AI)"
        }
      }
    }
    status.text = "Galería: ${gallery.active().size} identidades · procesamiento local"
  }

  // ------------------------------------------------------------------ ciclo de reconocimiento
  private fun start(which: Source) {
    lastSource = which
    lifecycleScope.launch {
      loop?.cancel()
      source?.stop()
      val src = when (which) {
        Source.PHONE_BACK -> PhoneCameraSource(this@MainActivity, this@MainActivity, CameraSelector.LENS_FACING_BACK)
        Source.PHONE_FRONT -> PhoneCameraSource(this@MainActivity, this@MainActivity, CameraSelector.LENS_FACING_FRONT)
        Source.GLASSES -> if (ensureGlassesCamera()) GlassesCameraSource() else return@launch
        Source.GLASSES_MOCK -> if (setupMockGlasses() && ensureGlassesCamera()) GlassesCameraSource() else return@launch
      }
      source = src
      pipeline.engine.reset()
      loop = launch(Dispatchers.Default) {
        src.frames().collect { frame ->
          if (privacy) { frame.release(); return@collect }
          if (askRequested) {
            askRequested = false
            pipeline.engine.request()
            pendingAsk = frame.timestampMs to false
          }
          val res = pipeline.process(frame.bitmap, frame.timestampMs)
          val unanswered = pendingAsk?.let { (t, sawFace) ->
            val saw = sawFace || res.face != null
            when {
              res.phrase != null -> null.also { pendingAsk = null }
              frame.timestampMs - t > 2500 -> (if (saw) UNCLEAR_PHRASE else NOBODY_PHRASE).also { pendingAsk = null }
              else -> null.also { pendingAsk = t to saw }
            }
          }
          val shown = drawOverlay(frame.bitmap, res)
          frame.release() // RN-02: el cuadro no sobrevive al ciclo
          withContext(Dispatchers.Main) {
            preview.setImageBitmap(shown)
            status.text = "${src.name} · ${res.state.name.lowercase()} · ${res.totalMs} ms" +
                (res.quality?.reason?.let { " · $it" } ?: if (res.sMax > -1) " · s=%.2f".format(res.sMax) else "")
            unanswered?.let(announcer::say)
            res.phrase?.let { phrase ->
              announcer.say(phrase)
              val a = res.announcement!!
              card.text = if (a.kind == Zone.MATCH) {
                val id = gallery.get(a.identityId!!)
                "${id?.name}\n${id?.relation}\nsimilitud %.2f · %d de %d cuadros · %d ms".format(a.sMax, a.hits, a.window, a.latencyMs)
              } else if (a.kind == Zone.REJECT) {
                "No es nadie conocido\nPodés invitarlo a sumarse al círculo.\nmejor candidata %.2f".format(a.sMax)
              } else {
                "No estoy seguro\nNo digo ningún nombre.\nmejor candidata %.2f".format(a.sMax)
              }
            }
            if (res.state == State.EN_REPOSO) card.text = ""
          }
        }
      }
    }
  }

  private suspend fun ensureGlassesCamera(): Boolean {
    if (!wearablesReady) { toast("Faltan permisos de Bluetooth"); return false }
    val current = Wearables.checkPermissionStatus(Permission.CAMERA)
    var granted = false
    current.onSuccess { granted = it == PermissionStatus.Granted }
    if (granted) return true
    val result = suspendCancellableCoroutine { cont ->
      glassesPermissionCont = cont
      glassesPermission.launch(Permission.CAMERA) // redirige a la app Meta AI
    }
    return (result == PermissionStatus.Granted).also { if (!it) toast("Permiso de cámara de las gafas denegado") }
  }

  /** Gafas simuladas: stream de la cámara trasera del teléfono a través del SDK, sin hardware. */
  private suspend fun setupMockGlasses(): Boolean {
    val kit = MockDeviceKit.getInstance(applicationContext)
    kit.enable(MockDeviceKitConfig(initiallyRegistered = true))
    var glasses: com.meta.wearable.dat.mockdevice.api.MockGlasses? = null
    kit.pairGlasses(GlassesModel.RAYBAN_META).fold(
        onSuccess = { glasses = it },
        onFailure = { e, _ -> toast("MockDeviceKit: ${e.description}") },
    )
    val g = glasses ?: return false
    g.powerOn()
    g.unfold()
    g.don()
    g.services.camera.setCameraFeed(CameraFacing.BACK)
    return true
  }

  private fun togglePrivacy(b: Button) {
    privacy = !privacy
    pipeline.engine.reset()
    b.text = if (privacy) "Reanudar" else "Modo privacidad"
    if (privacy) { preview.setImageBitmap(null); card.text = "Pausado · no hay captura ni inferencia" }
  }

  // ------------------------------------------------------------------ alta simplificada (CU-01)
  /**
   * Alta en este mismo teléfono con fines de prueba. En el diseño, el alta ocurre en el teléfono de la
   * persona enrolada (QR + P-04 + P-03); ese flujo completo está en el demo web.
   */
  private fun enroll() {
    val box = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL; setPadding(48, 16, 48, 0) }
    val name = EditText(this).apply { hint = "Nombre (Marta)" }.also(box::addView)
    val rel = EditText(this).apply { hint = "Vínculo (tu hija)" }.also(box::addView)
    AlertDialog.Builder(this)
        .setTitle("Tu cara, tus reglas")
        .setMessage(
            "Se guarda sólo un vector numérico de 512 valores, cifrado en este dispositivo. " +
                "No se guardan fotos. Vence en 12 meses y se puede revocar en cualquier momento.")
        .setView(box)
        .setPositiveButton("Acepto y me enrolo") { _, _ -> captureShots(name.text.toString().trim(), rel.text.toString().trim()) }
        .setNegativeButton("No, gracias") { _, _ -> toast("Rechazado: no se capturó ninguna imagen") }
        .show()
  }

  private fun captureShots(name: String, relation: String) {
    if (name.isEmpty() || relation.isEmpty()) return toast("Completá nombre y vínculo")
    val src = source ?: return toast("Iniciá una fuente de captura primero")
    loop?.cancel()
    lifecycleScope.launch(Dispatchers.Default) {
      val vecs = ArrayList<FloatArray>()
      var tries = 0
      src.frames().take(200).collect { f ->
        if (vecs.size >= 5) { f.release(); return@collect }
        val a = pipeline.analyze(f.bitmap, allowProfile = true)
        f.release()
        tries++
        a.embedding?.let { vecs += it; SystemClock.sleep(400) }
        withContext(Dispatchers.Main) { status.text = "Captura guiada · toma ${vecs.size}/5 · ${a.quality?.reason ?: "ok"}" }
      }
      withContext(Dispatchers.Main) {
        if (vecs.isEmpty()) return@withContext toast("Sin tomas válidas: no se creó plantilla")
        gallery.enroll(name, relation, centroid(vecs), Consent(identification = true), vecs.size)
        toast("Plantilla activa para $name · ${vecs.size} tomas")
        start(lastSource)
      }
    }
  }

  // ------------------------------------------------------------------ utilidades
  private fun drawOverlay(src: Bitmap, res: com.nievesjesus.mnemo.pipeline.FrameResult): Bitmap {
    val out = src.copy(Bitmap.Config.ARGB_8888, true)
    val face = res.face ?: return out
    val c = Canvas(out)
    val p = Paint().apply {
      style = Paint.Style.STROKE; strokeWidth = 4f
      color = when (res.zone) { Zone.MATCH -> Color.WHITE; Zone.ABSTAIN -> Color.rgb(232, 200, 114); else -> Color.GRAY }
    }
    c.drawRect(face.box[0], face.box[1], face.box[2], face.box[3], p)
    p.style = Paint.Style.FILL
    face.kps.forEach { c.drawCircle(it[0], it[1], 5f, p) }
    return out
  }

  private fun toast(msg: String) = runOnUiThread { Toast.makeText(this, msg, Toast.LENGTH_SHORT).show() }

  override fun onDestroy() {
    loop?.cancel()
    voice.stop()
    pipeline.close()
    announcer.shutdown()
    super.onDestroy()
  }
}
