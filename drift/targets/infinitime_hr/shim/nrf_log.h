#pragma once
/* Drift host shim: InfiniTime's heart-rate code includes <nrf_log.h> (Nordic SDK logging) and calls NRF_LOG_INFO.
 * On the host logging is a no-op.  This is the only InfiniTime dependency that is not in the algorithm files. */
#define NRF_LOG_INFO(...) ((void)0)
#define NRF_LOG_WARNING(...) ((void)0)
#define NRF_LOG_ERROR(...) ((void)0)
#define NRF_LOG_DEBUG(...) ((void)0)
