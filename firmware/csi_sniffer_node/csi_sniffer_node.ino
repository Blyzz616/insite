/*
 * InSite — CSI Sniffer Node
 * Board: Seeed Studio XIAO ESP32C6
 *
 * Captures WiFi Channel State Information (CSI) from received packets and
 * streams it over UDP to the processing server on your LAN.
 *
 * This does NOT do any signal processing on-device — the C6 doesn't have
 * the headroom (or the point) for that. It just packages CSI frames and
 * ships them out as fast as they arrive. All the real work (presence
 * detection, breathing rate extraction) happens on the server.
 *
 * Requires: Arduino-ESP32 core (board package "esp32 by Espressif Systems"),
 * board selected as "XIAO_ESP32C6".
 */

#include <WiFi.h>
#include <WiFiUdp.h>
#include "esp_wifi.h"

// ---------------------------------------------------------------------
// CONFIG — edit per node before flashing
// ---------------------------------------------------------------------
#define NODE_ID           "node-01"     // unique per sniffer node
#define WIFI_SSID         "YOUR_WIFI_SSID"
#define WIFI_PASSWORD     "YOUR_WIFI_PASSWORD"
#define SERVER_IP         "192.168.1.50" // your csi_server.py host
#define SERVER_UDP_PORT   9494
#define ENABLE_PROMISCUOUS_SNIFF 1       // 1 = capture CSI from ALL nearby
                                          // traffic (ambient AP + devices),
                                          // 0 = only from packets addressed
                                          // to this node's own STA connection
// ---------------------------------------------------------------------

WiFiUDP udp;

// Sequence counter so the server can detect dropped/out-of-order packets
static uint32_t g_seq = 0;

// Packed struct we send over UDP. Keep this in sync with
// server/csi_server.py's struct.unpack format string.
typedef struct __attribute__((packed)) {
  char     node_id[16];
  uint32_t seq;
  uint32_t timestamp_ms;
  int8_t   rssi;
  uint8_t  rate;
  uint8_t  channel;
  uint8_t  first_word_invalid; // see esp-idf CSI docs — C6 hardware quirk
  uint16_t csi_len;            // number of int8_t values following
  // CSI raw data follows immediately after this header in the UDP payload
} csi_packet_header_t;

void wifi_csi_rx_cb(void *ctx, wifi_csi_info_t *info) {
  if (!info || !info->buf) return;

  csi_packet_header_t hdr;
  memset(&hdr, 0, sizeof(hdr));
  strncpy(hdr.node_id, NODE_ID, sizeof(hdr.node_id) - 1);
  hdr.seq = g_seq++;
  hdr.timestamp_ms = millis();
  hdr.rssi = info->rx_ctrl.rssi;
  hdr.rate = info->rx_ctrl.rate;
  hdr.channel = info->rx_ctrl.channel;
  hdr.first_word_invalid = info->first_word_invalid ? 1 : 0;
  hdr.csi_len = info->len;

  // Build one UDP payload: [header][raw csi bytes]
  size_t total_len = sizeof(hdr) + info->len;
  if (total_len > 1400) {
    // Keep well under typical MTU (1500) minus IP/UDP overhead.
    // If this fires often, consider chunking — most CSI frames from
    // HT20 are small enough this shouldn't trigger.
    return;
  }

  uint8_t packet[1400];
  memcpy(packet, &hdr, sizeof(hdr));
  memcpy(packet + sizeof(hdr), info->buf, info->len);

  udp.beginPacket(SERVER_IP, SERVER_UDP_PORT);
  udp.write(packet, total_len);
  udp.endPacket();
}

void setup() {
  Serial.begin(115200);
  delay(1000);
  Serial.printf("[%s] booting CSI sniffer node\n", NODE_ID);

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print("connecting to wifi");
  while (WiFi.status() != WL_CONNECTED) {
    delay(400);
    Serial.print(".");
  }
  Serial.printf("\nconnected, IP: %s\n", WiFi.localIP().toString().c_str());

  udp.begin(SERVER_UDP_PORT); // local bind, not strictly required for send-only

#if ENABLE_PROMISCUOUS_SNIFF
  // Promiscuous mode lets us pick up CSI from ambient traffic (your home
  // AP talking to other devices, phones, etc.) rather than only packets
  // addressed to this node. Good for passive sensing without needing a
  // dedicated beacon node.
  wifi_promiscuous_filter_t filter = {
    .filter_mask = WIFI_PROMIS_FILTER_MASK_DATA | WIFI_PROMIS_FILTER_MASK_MGMT
  };
  esp_wifi_set_promiscuous_filter(&filter);
  esp_wifi_set_promiscuous(true);
#endif

  wifi_csi_config_t csi_config = {
    .lltf_en = true,
    .htltf_en = true,
    .stbc_htltf2_en = true,
    .ltf_merge_en = true,
    .channel_filter_en = false,
    .manu_scale = false,
    .shift = false,
  };
  ESP_ERROR_CHECK(esp_wifi_set_csi_config(&csi_config));
  ESP_ERROR_CHECK(esp_wifi_set_csi_rx_cb(wifi_csi_rx_cb, NULL));
  ESP_ERROR_CHECK(esp_wifi_set_csi(true));

  Serial.println("CSI capture enabled, streaming to server...");
}

void loop() {
  // All the work happens in the CSI callback (wifi_csi_rx_cb) and WiFi
  // stack internally. Just keep the link alive here.
  if (WiFi.status() != WL_CONNECTED) {
    Serial.println("wifi dropped, reconnecting...");
    WiFi.reconnect();
    delay(2000);
  }
  delay(1000);
}
