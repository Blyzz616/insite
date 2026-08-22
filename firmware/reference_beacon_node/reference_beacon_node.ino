/*
 * InSite — Reference Beacon Node (OPTIONAL)
 * Board: Seeed Studio XIAO ESP32C6
 *
 * You likely don't need this file. If your sniffer nodes are set to
 * ENABLE_PROMISCUOUS_SNIFF (see csi_sniffer_node.ino), they'll pick up
 * CSI from your existing home WiFi traffic passively — no extra hardware
 * needed.
 *
 * Use this only if you want a controlled, fixed-rate, known-position
 * transmit source instead of relying on ambient traffic — e.g. for more
 * consistent breathing-rate measurements where you want a predictable
 * packet rate rather than whatever your AP happens to be sending.
 *
 * This just runs as a WiFi AP and periodically sends small broadcast
 * UDP packets at a fixed interval, giving nearby sniffer nodes a
 * steady, known packet source to compute CSI against.
 */

#include <WiFi.h>
#include <WiFiUdp.h>

#define BEACON_SSID       "csi-beacon"
#define BEACON_PASSWORD   "changeme123"   // WPA2 requires >= 8 chars
#define BEACON_INTERVAL_MS 50              // ~20 packets/sec

WiFiUDP udp;
IPAddress broadcastIP(255, 255, 255, 255);
const int BEACON_PORT = 9495;

void setup() {
  Serial.begin(115200);
  delay(1000);

  WiFi.mode(WIFI_AP);
  WiFi.softAP(BEACON_SSID, BEACON_PASSWORD);
  Serial.printf("Beacon AP up: %s, IP: %s\n",
                BEACON_SSID, WiFi.softAPIP().toString().c_str());

  udp.begin(BEACON_PORT);
}

void loop() {
  static uint32_t counter = 0;
  uint8_t payload[8];
  payload[0] = 'B'; payload[1] = 'C'; payload[2] = 'N'; payload[3] = 0;
  memcpy(payload + 4, &counter, sizeof(counter));

  udp.beginPacket(broadcastIP, BEACON_PORT);
  udp.write(payload, sizeof(payload));
  udp.endPacket();

  counter++;
  delay(BEACON_INTERVAL_MS);
}
